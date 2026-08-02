import { Clock, Effect, Option, Result } from "effect";
import { resetRecoveryLadder } from "../domain/recovery.ts";
import { inferKind } from "../domain/artifact-kind.ts";
import { timeoutMsForKind } from "../domain/timeouts.ts";
import {
	asVerdict,
	isCompleteArtifact,
	parseFrontMatter,
} from "../domain/frontmatter.ts";
import { looksLikeShellOnly, parseFloatingExit } from "../domain/herdr.ts";
import { abs, rel } from "../domain/paths.ts";
import {
	nextAfter,
	stepAfterArtifact,
	toolAllowed,
} from "../domain/state-machine.ts";
import {
	ArtifactInvalid,
	GateRefused,
	HerdrError,
	WaitAborted,
	WaitTimeout,
	type AppError,
} from "../errors.ts";
import type { FrontMatter } from "../domain/types.ts";
import { ok, type ToolResult } from "../result.ts";
import { decodeFrontMatterResult } from "../schema/frontmatter.ts";
import { Config } from "../services/config.ts";
import { FileSystem } from "../services/file-system.ts";
import { Herdr } from "../services/herdr.ts";
import { RunStore } from "../services/run-store.ts";
import { Vcs } from "../services/vcs.ts";

export type WaitParams = {
	poll_ms?: number;
	/**
	 * Wall-clock this single call may block for. Defaults to
	 * `DEFAULT_BUDGET_MS` so the call fits inside an unconfigured host shell.
	 * The role's real deadline lives in `state.pending_deadline_ms` and is
	 * unaffected — spending the budget returns "still waiting", not a timeout.
	 */
	budget_ms?: number;
};

/**
 * Fits inside an unconfigured host shell. Agent shell tools commonly default
 * to a 120s timeout. (600s is the maximum Claude Code accepts, not its
 * default.) A longer budget is killed before it can return the exit-3 "call
 * me again" result. The caller then sees a killed command, which is the one
 * outcome the chunked design exists to prevent.
 */
export const DEFAULT_BUDGET_MS = 90_000;

/**
 * Shortest usable poll. Each poll spawns `herdr pane get` and
 * `herdr pane foreground-names`, so a 1ms interval is ~144k subprocesses over
 * one floor-length call. A sign check alone let that through.
 */
export const MIN_POLL_MS = 250;

/** Grace after dispatch before a pane is judged missing or shell-only. */
export const GRACE_MS = 12_000;

/** Consecutive shell-only polls before the harness is declared dead. */
export const DEAD_POLLS_NEEDED = 4;

/**
 * Continuous idle time before the role is nudged once.
 *
 * 60s, not 90s, so the whole rung fits inside one default-budget call:
 * `GRACE_MS + IDLE_NUDGE_AFTER_MS` is 72s, under `DEFAULT_BUDGET_MS`.
 *
 * This buys the rung its margin at the cost of signal quality, and the trade is
 * real in both directions. A role can read `idle` for 60-89s while it is doing
 * legitimate work — a coder blocked on a slow test run, a planner between
 * streaming turns — and the nudge lands in its pane mid-turn. The nudge is
 * one-shot, so a false one is also spent. At 90s the floor would be 102s, which
 * forces `DEFAULT_BUDGET_MS` up to ~105s and leaves ~15s of margin under a 120s
 * host shell. 60s trades some false-nudge risk for that margin; raising it back
 * means raising the default budget with it.
 */
export const IDLE_NUDGE_AFTER_MS = 60_000;

/**
 * The host shell timeout this design assumes. Not enforced by us — it belongs
 * to whatever agent harness runs `apnea wait`, and 120s is the common default.
 * Every budget rule here exists to return an exit-3 resume instruction before
 * this fires, because a killed command carries no instruction at all.
 */
export const HOST_SHELL_TIMEOUT_MS = 120_000;

/**
 * Smallest budget that lets every duration-based rung complete inside one
 * call.
 *
 * Two rungs measure a duration by polling: the idle nudge needs
 * `IDLE_NUDGE_AFTER_MS` of unbroken idleness, and the dead-harness check needs
 * `DEAD_POLLS_NEEDED` consecutive shell-only polls. Both start counting after
 * `GRACE_MS`.
 *
 * An earlier version of this file tried to carry those counters across calls
 * in `state.json` instead. That cannot be made correct: nothing observes the
 * role between calls, so the counter has to guess what happened in the gap.
 * Guessing "still idle" nudges a role that was working; guessing "not idle"
 * discards the evidence and the rung never fires. Both were reproduced. A
 * duration is only meaningful over an interval something actually watched, so
 * the call has to be long enough to contain it.
 *
 * Facts, unlike durations, survive a gap safely and stay in `state.json`: the
 * deadline, the one-time extension, the final grace, and whether a nudge was
 * sent.
 */
export const minBudgetFor = (pollMs: number): number =>
	GRACE_MS + Math.max(IDLE_NUDGE_AFTER_MS, DEAD_POLLS_NEEDED * pollMs);

/**
 * The budget used when the caller did not pick one.
 *
 * Raised to the floor, because leaving it at the bare default made
 * `apnea wait --poll=20000` — legal on main — exit 1 with a floor refusal.
 *
 * Exported so the tests drive their clock off the same rule the call uses.
 * They had their own copy of this expression; a change here then advanced the
 * test clock short of where the call actually returns, and the suite hung on a
 * join that never resolved instead of failing with a readable message.
 */
export const defaultBudgetFor = (pollMs: number): number =>
	Math.max(DEFAULT_BUDGET_MS, minBudgetFor(pollMs));

/**
 * Largest poll we will pick a budget for, advertised in the refusal message.
 *
 * The `- 1` is load-bearing: the budget has to land STRICTLY under the shell
 * timeout, because a call that runs exactly `HOST_SHELL_TIMEOUT_MS` is killed
 * at the same instant it would have returned exit 3. `Math.floor` alone gave
 * 27000, whose budget is exactly 120000 — the boundary the ceiling exists to
 * stay off. Nothing gates on this constant; `fitsHostShell` does the deciding,
 * so a wrong value here misadvises but cannot let a doomed call through.
 */
export const MAX_AUTO_POLL_MS =
	Math.ceil((HOST_SHELL_TIMEOUT_MS - GRACE_MS) / DEAD_POLLS_NEEDED) - 1;

/**
 * Would a budget we pick ourselves survive a default host shell?
 *
 * Phrased as the invariant rather than as a poll bound. The first version
 * compared `poll` against a separately derived ceiling, and the two drifted by
 * one poll interval — the arithmetic that decides is now the arithmetic that
 * runs.
 */
export const fitsHostShell = (pollMs: number): boolean =>
	defaultBudgetFor(pollMs) < HOST_SHELL_TIMEOUT_MS;

export type WaitHooks = {
	signal?: AbortSignal;
	onUpdate?: (partial: {
		content: Array<{ type: "text"; text: string }>;
	}) => void;
};

/**
 * Async wait — polls via `Clock` + `Effect.sleep` so Pi stays responsive and
 * an `AbortSignal` (Esc) interrupts through `Effect.raceFirst`, not a flag
 * check.
 *
 * Recovery (does not immediately escalate):
 * - idle/done without artifact for ≥60s → one nudge prompt into the role pane
 * - still working/blocked at timeout → extend budget once by max(50%, 2m)
 * - idle at final timeout and never nudged → final nudge + 3m grace
 */
export const waitWorkflow = (
	params: WaitParams,
	root: string,
	hooks: WaitHooks = {},
): Effect.Effect<
	ToolResult,
	AppError,
	FileSystem | RunStore | Config | Vcs | Herdr
> =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		const fs = yield* FileSystem;
		const config = yield* Config;
		const vcsSvc = yield* Vcs;
		const herdr = yield* Herdr;

		const state = yield* store.require(root);

		const allowed = toolAllowed(state.step, "workflow_wait");
		if (Result.isFailure(allowed)) {
			return yield* allowed.failure;
		}

		if (!state.pending_artifact) {
			return yield* new GateRefused({
				gate: "wait",
				message: "no pending_artifact; dispatch_role first",
			});
		}
		const pendingArtifact = state.pending_artifact;

		const cfg = yield* config.load(root);

		const poll = params.poll_ms ?? 2000;
		if (!Number.isFinite(poll) || poll < MIN_POLL_MS) {
			return yield* new GateRefused({
				gate: "poll_interval",
				message: `poll_ms must be a finite number >= ${MIN_POLL_MS}; got ${poll}. Every poll spawns two herdr subprocesses, so a tiny interval is a busy-spin, not a faster wait.`,
			});
		}
		// Refuse to PICK a budget that a default host shell would kill; still
		// honour one the caller picked. Raising the budget silently was the
		// whole point of `defaultBudgetFor`, but above `MAX_AUTO_POLL_MS` that
		// raise lands past `HOST_SHELL_TIMEOUT_MS`, and the caller gets a killed
		// command instead of the exit-3 resume instruction — the exact outcome
		// the 90s default exists to prevent. Passing `--budget` explicitly is a
		// deliberate opt-in to a longer call, so it stays legal.
		if (params.budget_ms == null && !fitsHostShell(poll)) {
			return yield* new GateRefused({
				gate: "poll_interval",
				message:
					`poll_ms=${poll} needs a budget of at least ${minBudgetFor(poll)}ms, ` +
					`over the ${HOST_SHELL_TIMEOUT_MS}ms an agent shell commonly allows. ` +
					`This call would be killed before it could tell you to call again. ` +
					`Lower --poll to ${MAX_AUTO_POLL_MS} or less, or pass --budget explicitly ` +
					`if your shell allows a longer call.`,
			});
		}
		const budget = params.budget_ms ?? defaultBudgetFor(poll);
		// `Number.isFinite` first: every comparison against NaN is false, so an
		// unvalidated NaN slips past the floor checks below, makes `budgetEnd`
		// NaN, and the call blocks until the role's deadline instead of
		// returning exit 3. The CLI is protected by `parseNumFlag`; a Pi tool
		// call reaches `run` through a raw cast with no runtime coercion.
		if (!Number.isFinite(budget)) {
			return yield* new GateRefused({
				gate: "budget_floor",
				message: `budget_ms must be a finite number; got ${budget}`,
			});
		}
		const floor = minBudgetFor(poll);
		if (budget < floor) {
			return yield* new GateRefused({
				gate: "budget_floor",
				message:
					`budget_ms must be >= ${floor} at poll_ms=${poll}; got ${budget}. ` +
					`A shorter call cannot contain the ${GRACE_MS}ms grace plus either the ` +
					`${IDLE_NUDGE_AFTER_MS}ms idle nudge or ${DEAD_POLLS_NEEDED} polls, and those ` +
					`durations cannot be measured across calls — nothing watches the role in between. ` +
					`Raise --budget, or lower --poll.`,
			});
		}
		const startedMs = yield* Clock.currentTimeMillis;
		const budgetEnd = startedMs + budget;
		const artifactAbs = abs(pendingArtifact, root);
		const kindResult = inferKind(pendingArtifact);
		if (Result.isFailure(kindResult)) {
			return yield* kindResult.failure;
		}
		const kind = kindResult.success;
		// The role's CONFIGURED timeout, not `pending_deadline_ms - dispatchedAt`.
		// The recovery ladder moves the deadline, so the subtraction returned an
		// inflated span on any later call: the one-time extension was sized from
		// it (540s instead of 450s for a 900s role) and `WaitTimeout` reported it
		// to the human as if it were the configured value.
		const timeout = timeoutMsForKind(kind, cfg.timeouts_ms);

		// Legacy state (dispatched before the clock existed) starts its budget now.
		// The stamp has to come from `timeout` — the same per-kind lookup the
		// extension and the `WaitTimeout` report use. It read `timeouts_ms.default`
		// while `timeout` read the per-kind key, so a legacy coder configured for
		// 45m was killed at the 15m default and then told it had been given 45.
		const dispatchedAt = state.pending_started_at ?? startedMs;
		if (state.pending_deadline_ms == null) {
			state.pending_started_at = dispatchedAt;
			state.pending_deadline_ms = dispatchedAt + timeout;
			yield* store.save(state, root);
		}
		const requireVerdict = kind === "plan_review" || kind === "code_review";

		const readArtifact = (): Effect.Effect<FrontMatter | null> =>
			Effect.gen(function* () {
				const present = yield* fs.exists(artifactAbs);
				if (!present) return null;
				const text = yield* fs.readFile(artifactAbs);
				return parseFrontMatter(text);
			});

		const readFloatingExitCode = (
			exitAbs: string,
		): Effect.Effect<number | null> =>
			Effect.gen(function* () {
				const present = yield* fs.exists(exitAbs);
				if (!present) return null;
				const text = yield* fs.readFile(exitAbs);
				return parseFloatingExit(text);
			});

		const advanceOnComplete = (
			fm: FrontMatter,
			msg = "artifact ready",
		): Effect.Effect<ToolResult, AppError> =>
			Effect.gen(function* () {
				if (
					state.pending_role === "reviewer" &&
					state.reviewer_tree_fingerprint != null
				) {
					const now = yield* vcsSvc.treeFingerprint(root, state.vcs);
					if (now !== state.reviewer_tree_fingerprint) {
						state.last_error = "reviewer dirtied file tree";
						yield* store.save(state, root);
						return yield* new GateRefused({
							gate: "reviewer_clean_tree",
							message:
								"reviewer dirty-tree detection: file content changed during review — escalate to human",
							details: {
								before: state.reviewer_tree_fingerprint,
								after: now,
								artifact: pendingArtifact,
							},
						});
					}
				}

				const next = stepAfterArtifact(kind, fm.verdict);
				if (typeof next === "object") {
					return yield* new ArtifactInvalid({
						artifact: pendingArtifact,
						message: next.error,
					});
				}

				// Post-completion Schema guard only — isCompleteArtifact above is the
				// completeness test. A bad/absent verdict must keep waiting, not fail
				// here (that already happened before advanceOnComplete was called).
				//
				// Only review kinds carry a meaningful verdict. A stray `verdict:` on
				// a plan/code/package artifact is noise the old parser ignored;
				// validating it here would wedge the run permanently (state is not
				// saved on failure, so every retry fails identically).
				const decoded = decodeFrontMatterResult(
					{
						status: fm.status,
						...(requireVerdict ? { verdict: fm.verdict } : {}),
						nits: fm.nits,
					},
					pendingArtifact,
				);
				if (Result.isFailure(decoded)) {
					return yield* decoded.failure;
				}

				if (kind === "phase_package") {
					state.current_phase_package = pendingArtifact;
				}
				if (kind === "code_review") {
					state.current_code_review = pendingArtifact;
				}

				const verdict = asVerdict(fm.verdict);
				state.step = next;
				state.pending_artifact = null;
				state.pending_role = null;
				state.pending_pane_id = null;
				state.pending_pane_label = null;
				state.pending_floating_exit = null;
				state.pending_started_at = null;
				state.pending_deadline_ms = null;
				resetRecoveryLadder(state);
				state.reviewer_tree_fingerprint = null;
				state.last_error = null;
				yield* store.save(state, root);

				return ok(
					`${msg}; step → ${next}`,
					{
						artifact: rel(artifactAbs, root),
						kind,
						verdict,
						nits: fm.nits ?? null,
						step: next,
					},
					nextAfter(next),
				);
			});

		const floatingFlushMs = 2_000;

		let lastStatus = "waiting";
		/**
		 * Both counters below are per-call on purpose. They measure a duration
		 * by polling, and `minBudgetFor` guarantees this call is long enough to
		 * contain either one. Persisting them was tried and reverted: a counter
		 * that spans calls has to assume something about the gap it did not
		 * observe, and both assumptions produce real bugs.
		 */
		let shellOnlyPolls = 0;
		let idleSince: number | null = null;
		let floatingExitSeenAt: number | null = null;
		let nudged = state.pending_nudged_at != null;
		let extendedOnce = state.pending_extended;
		let finalNudgeGrace = state.pending_final_grace;

		const nudgePrompt =
			`You appear idle without writing the required artifact.\n` +
			`Write it now exactly at: ${pendingArtifact}\n` +
			`Front-matter must include status: done` +
			(requireVerdict ? ` and verdict: APPROVED | CHANGES_REQUIRED` : "") +
			`. Follow the brief and task file. Do not invent paths.`;

		/**
		 * `force` is for the deadline rung only.
		 *
		 * The `nudged` guard stops the IDLE rung re-prompting every poll, which
		 * is right — but the final grace exists to give a prompt time to land,
		 * and suppressing the prompt turns it into 180s of silence before the
		 * same escalation. A role that ignored its idle nudge got the delay
		 * without the second chance. `pending_final_grace` already makes the
		 * deadline rung one-shot per run, so forcing it cannot spam a pane.
		 */
		const tryNudge = (why: string, force = false): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (
					(nudged && !force) ||
					!(yield* herdr.enabled) ||
					!state.pending_pane_id
				) {
					return;
				}
				const outcome = yield* Effect.option(
					herdr.paneRun(state.pending_pane_id, nudgePrompt),
				);
				// Back off either way so a failing pane is not re-prompted every
				// poll; only a delivered nudge burns the rung. Restarting the
				// idle clock is the back-off: another full IDLE_NUDGE_AFTER_MS
				// of unbroken idleness must pass before a retry.
				idleSince = yield* Clock.currentTimeMillis;
				if (Option.isNone(outcome)) return;
				// Persisted only after the send succeeded. Recording it first made a
				// failed `paneRun` disable both nudge rungs for the rest of the run
				// while `WaitTimeout` still reported `nudged: true`. The opposite
				// failure — a crash between send and save — costs one extra prompt.
				nudged = true;
				state.pending_nudged_at = idleSince;
				yield* store.save(state, root);
				hooks.onUpdate?.({
					content: [
						{
							type: "text",
							text: `${why} — nudged ${state.pending_role} to write ${pendingArtifact}`,
						},
					],
				});
			});

		hooks.onUpdate?.({
			content: [
				{
					type: "text",
					text: `waiting for ${pendingArtifact} (timeout ${Math.round(timeout / 1000)}s)…`,
				},
			],
		});

		const loop: Effect.Effect<ToolResult, AppError> = Effect.gen(
			function* () {
				while (true) {
					const now = yield* Clock.currentTimeMillis;
					const deadline = state.pending_deadline_ms ?? startedMs + timeout;

					const fm = yield* readArtifact();
					if (isCompleteArtifact(fm, { requireVerdict })) {
						return yield* advanceOnComplete(
							fm!,
							nudged ? "artifact ready after nudge" : "artifact ready",
						);
					}

					// Floating oneshot: no pane id — exit file is liveness. Fail closed
					// when the popup dies without a complete artifact instead of
					// hanging until timeout.
					if (state.pending_floating_exit) {
						const exitAbs = abs(state.pending_floating_exit, root);
						const code = yield* readFloatingExitCode(exitAbs);
						if (code != null) {
							lastStatus = `floating_exit_${code}`;
							floatingExitSeenAt ??= now;
							// Short flush window: oneshot may finish writing as the process exits.
							if (now - floatingExitSeenAt >= floatingFlushMs) {
								const again = yield* readArtifact();
								if (isCompleteArtifact(again, { requireVerdict })) {
									return yield* advanceOnComplete(
										again!,
										"artifact ready (floating oneshot exited)",
									);
								}
								state.pending_floating_exit = null;
								state.last_error = `floating oneshot exited ${code} without ${pendingArtifact}`;
								yield* store.save(state, root);
								return yield* new HerdrError({
									message: `floating ${state.pending_role} exited (code ${code}) without writing ${pendingArtifact}`,
									details: {
										exit_code: code,
										last_agent_status: lastStatus,
										hint:
											code === 129
												? "popup received Hangup (dismiss/focus steal) — re-dispatch same round; keep focus on the popup"
												: "inspect oneshot output; re-dispatch same round or set pane_style=regular",
									},
								});
							}
						} else {
							lastStatus = "floating_running";
						}
					}

					if ((yield* herdr.enabled) && state.pending_pane_id) {
						const info = yield* herdr.paneGet(state.pending_pane_id);
						if (!info.ok) {
							lastStatus = "pane_missing";
							if (now - dispatchedAt > GRACE_MS) {
								state.last_error = `role pane missing while waiting for ${pendingArtifact}`;
								yield* store.save(state, root);
								return yield* new HerdrError({
									message: `role pane gone and artifact incomplete: ${pendingArtifact}`,
									details: {
										last_agent_status: lastStatus,
										hint: "re-dispatch same round after investigate",
									},
								});
							}
						} else {
							lastStatus = info.agent_status ?? "unknown";

							const isIdle = lastStatus === "idle" || lastStatus === "done";
							if (isIdle) {
								// Per-call timestamp. `minBudgetFor` guarantees this call
								// is long enough to reach the threshold from here.
								if (idleSince == null) idleSince = now;
								else if (
									now - idleSince >= IDLE_NUDGE_AFTER_MS &&
									now - dispatchedAt > GRACE_MS
								) {
									yield* tryNudge("idle stall");
								}
							} else {
								idleSince = null;
							}

							if (now - dispatchedAt > GRACE_MS) {
								const names = yield* herdr.paneForegroundNames(
									state.pending_pane_id,
								);
								if (looksLikeShellOnly(names)) {
									const again = yield* readArtifact();
									if (!isCompleteArtifact(again, { requireVerdict })) {
										shellOnlyPolls += 1;
										if (shellOnlyPolls >= DEAD_POLLS_NEEDED) {
											state.last_error = `role pane shell-only without artifact ${pendingArtifact}`;
											yield* store.save(state, root);
											return yield* new HerdrError({
												message: `${state.pending_role} harness exited without writing ${pendingArtifact}`,
												details: {
													last_agent_status: lastStatus,
													foreground: names,
													hint: "check pane transcript; re-dispatch same round",
												},
											});
										}
									}
								} else {
									shellOnlyPolls = 0;
								}
							}
						}
					}

					if (now >= budgetEnd && now < deadline) {
						const elapsed = Math.round((now - dispatchedAt) / 1000);
						const remaining = Math.round((deadline - now) / 1000);
						return ok(
							`still waiting for ${pendingArtifact} (${elapsed}s elapsed, ${remaining}s before timeout)`,
							{
								pending: true,
								artifact: pendingArtifact,
								elapsed_s: elapsed,
								remaining_s: remaining,
								last_agent_status: lastStatus,
							},
							["workflow_wait"],
						);
					}

					if (now >= deadline) {
						// Still working: extend once.
						if (
							!extendedOnce &&
							(lastStatus === "working" || lastStatus === "blocked")
						) {
							extendedOnce = true;
							const extra = Math.max(Math.floor(timeout * 0.5), 120_000);
							state.pending_extended = true;
							state.pending_deadline_ms = now + extra;
							yield* store.save(state, root);
							hooks.onUpdate?.({
								content: [
									{
										type: "text",
										text: `agent still ${lastStatus} at timeout — extending ${Math.round(extra / 1000)}s once…`,
									},
								],
							});
							continue;
						}

						// Idle at the deadline: final nudge + short grace.
						//
						// `pending_final_grace` alone makes this one-shot per run — an
						// earlier `!nudged` guard coupled it to the idle rung, so a role
						// nudged early silently lost its grace. The nudge is FORCED: the
						// grace is time for a prompt to land, so an already-nudged role
						// that got the window but not the prompt only delayed its own
						// escalation by three minutes.
						if (
							!finalNudgeGrace &&
							(lastStatus === "idle" || lastStatus === "done") &&
							state.pending_pane_id
						) {
							// Grant the whole thing in ONE save, then nudge. A flag
							// persisted apart from the moved deadline is a divisible
							// grant: an abort in between leaves the flag on disk with
							// the old deadline, and the next call skips the rung and
							// times out 180s early. The nudge is best-effort; the
							// grace is not.
							finalNudgeGrace = true;
							state.pending_final_grace = true;
							state.pending_deadline_ms = now + 180_000;
							yield* store.save(state, root);
							yield* tryNudge("timeout idle", true);
							continue;
						}

						break;
					}

					const elapsed = Math.round((now - dispatchedAt) / 1000);
					hooks.onUpdate?.({
						content: [
							{
								type: "text",
								text: `waiting ${elapsed}s for ${pendingArtifact} (agent=${lastStatus})…`,
							},
						],
					});

					// Clamp the sleep to the budget. Sleeping a full `poll` past
					// `budgetEnd` is what let a legal `--budget=90000 --poll=60000`
					// block ~120s: the budget is only re-checked at the top of the
					// loop, so the call outlived the host shell timeout the default
					// budget exists to fit inside, and the caller saw a killed
					// command instead of the exit-3 resume instruction.
					// Re-read: `now` predates this iteration's herdr subprocess calls,
					// and clamping from a stale reading overshoots `budgetEnd` by
					// however long they took.
					const afterPolls = yield* Clock.currentTimeMillis;
					yield* Effect.sleep(
						Math.min(poll, Math.max(0, budgetEnd - afterPolls)),
					);
				}

				state.last_error = `timeout waiting for ${pendingArtifact}`;
				yield* store.save(state, root);
				// Report what the role ACTUALLY got, not what config allows. The
				// two differ by every rung that moved the deadline, and only this
				// number answers the question a human asks here — was the timeout
				// too tight? Reporting the configured 900s for a role that ran
				// 1530s on an extension plus a grace invites raising a limit that
				// was never the problem. `timeout` still sizes the extension,
				// because that has to come from config to stay stable across calls.
				const grantedMs =
					(state.pending_deadline_ms ?? dispatchedAt + timeout) - dispatchedAt;
				return yield* new WaitTimeout({
					artifact: pendingArtifact,
					timeoutMs: grantedMs,
					details: {
						last_agent_status: lastStatus,
						nudged,
						extended_once: extendedOnce,
						configured_timeout_ms: timeout,
						hint: "inspect pane transcript; re-dispatch same round or nudge via herdr pane run",
					},
				});
			},
		);

		const abortEffect = (
			signal: AbortSignal,
			artifact: string,
		): Effect.Effect<never, WaitAborted> =>
			Effect.callback<never, WaitAborted>((resume) => {
				const fail = () => {
					resume(
						Effect.fail(
							new WaitAborted({
								artifact,
								details: {
									last_agent_status: lastStatus,
									hint: "re-dispatch same round or wait again after investigate",
								},
							}),
						),
					);
				};
				if (signal.aborted) {
					fail();
					return;
				}
				signal.addEventListener("abort", fail, { once: true });
				return Effect.sync(() => signal.removeEventListener("abort", fail));
			});

		const raced: Effect.Effect<ToolResult, AppError> = hooks.signal
			? Effect.raceFirst(loop, abortEffect(hooks.signal, pendingArtifact))
			: loop;

		const r = yield* Effect.result(raced);
		if (Result.isFailure(r)) {
			if (r.failure._tag === "WaitAborted") {
				state.last_error = "workflow_wait aborted";
				yield* store.save(state, root);
			}
			return yield* r.failure;
		}
		return r.success;
	});
