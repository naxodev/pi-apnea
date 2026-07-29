import { Clock, Effect, Option, Result } from "effect";
import { inferKind } from "../domain/artifact-kind.ts";
import {
	asVerdict,
	isCompleteArtifact,
	parseFrontMatter,
} from "../domain/frontmatter.ts";
import { looksLikeShellOnly, parseFloatingExit } from "../domain/herdr.ts";
import { abs, rel } from "../domain/paths.ts";
import { stepAfterArtifact, toolAllowed } from "../domain/state-machine.ts";
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
	timeout_ms?: number;
	poll_ms?: number;
};

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
 * - idle/done without artifact for ≥90s → one nudge prompt into the role pane
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

		const timeout = params.timeout_ms ?? cfg.timeouts_ms.default ?? 900_000;
		const poll = params.poll_ms ?? 2000;
		const artifactAbs = abs(pendingArtifact, root);
		const kindResult = inferKind(pendingArtifact);
		if (Result.isFailure(kindResult)) {
			return yield* kindResult.failure;
		}
		const kind = kindResult.success;
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
				state.pending_nudged_at = null;
				state.pending_extended = false;
				state.reviewer_tree_fingerprint = null;
				state.last_error = null;
				yield* store.save(state, root);

				return ok(`${msg}; step → ${next}`, {
					artifact: rel(artifactAbs, root),
					kind,
					verdict,
					nits: fm.nits ?? null,
					step: next,
					legal_next:
						next === "committing"
							? ["workflow_commit_phase"]
							: next === "done"
								? ["workflow_status"]
								: ["dispatch_role", "workflow_status"],
				});
			});

		const graceMs = 12_000;
		const deadPollsNeeded = 4;
		const idleNudgeAfterMs = 90_000;
		const floatingFlushMs = 2_000;

		let lastStatus = "waiting";
		let shellOnlyPolls = 0;
		let idleSince: number | null = null;
		let floatingExitSeenAt: number | null = null;
		let nudged = false;
		let extendedOnce = false;
		let finalNudgeGrace = false;

		const nudgePrompt =
			`You appear idle without writing the required artifact.\n` +
			`Write it now exactly at: ${pendingArtifact}\n` +
			`Front-matter must include status: done` +
			(requireVerdict ? ` and verdict: APPROVED | CHANGES_REQUIRED` : "") +
			`. Follow the brief and task file. Do not invent paths.`;

		const tryNudge = (why: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (nudged || !(yield* herdr.enabled) || !state.pending_pane_id) {
					return;
				}
				nudged = true;
				const outcome = yield* Effect.option(
					herdr.paneRun(state.pending_pane_id, nudgePrompt),
				);
				if (Option.isSome(outcome)) {
					hooks.onUpdate?.({
						content: [
							{
								type: "text",
								text: `${why} — nudged ${state.pending_role} to write ${pendingArtifact}`,
							},
						],
					});
				}
				idleSince = yield* Clock.currentTimeMillis;
			});

		hooks.onUpdate?.({
			content: [
				{
					type: "text",
					text: `waiting for ${pendingArtifact} (timeout ${Math.round(timeout / 1000)}s)…`,
				},
			],
		});

		const startedMs = yield* Clock.currentTimeMillis;
		let deadline = startedMs + timeout;

		const loop: Effect.Effect<ToolResult, AppError> = Effect.gen(
			function* () {
				while (true) {
					const now = yield* Clock.currentTimeMillis;

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
							if (now - startedMs > graceMs) {
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

							if (lastStatus === "idle" || lastStatus === "done") {
								if (idleSince == null) idleSince = now;
								else if (
									now - idleSince >= idleNudgeAfterMs &&
									now - startedMs > graceMs
								) {
									yield* tryNudge("idle stall");
								}
							} else {
								idleSince = null;
							}

							if (now - startedMs > graceMs) {
								const names = yield* herdr.paneForegroundNames(
									state.pending_pane_id,
								);
								if (looksLikeShellOnly(names)) {
									const again = yield* readArtifact();
									if (!isCompleteArtifact(again, { requireVerdict })) {
										shellOnlyPolls += 1;
										if (shellOnlyPolls >= deadPollsNeeded) {
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

					if (now >= deadline) {
						// Still working: extend once.
						if (
							!extendedOnce &&
							(lastStatus === "working" || lastStatus === "blocked")
						) {
							extendedOnce = true;
							const extra = Math.max(Math.floor(timeout * 0.5), 120_000);
							deadline = now + extra;
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

						// Idle and never nudged: final nudge + short grace.
						if (
							!finalNudgeGrace &&
							!nudged &&
							(lastStatus === "idle" || lastStatus === "done") &&
							state.pending_pane_id
						) {
							finalNudgeGrace = true;
							yield* tryNudge("timeout idle");
							deadline = now + 180_000;
							continue;
						}

						break;
					}

					const elapsed = Math.round((now - startedMs) / 1000);
					hooks.onUpdate?.({
						content: [
							{
								type: "text",
								text: `waiting ${elapsed}s for ${pendingArtifact} (agent=${lastStatus})…`,
							},
						],
					});

					yield* Effect.sleep(poll);
				}

				state.last_error = `timeout waiting for ${pendingArtifact}`;
				yield* store.save(state, root);
				return yield* new WaitTimeout({
					artifact: pendingArtifact,
					timeoutMs: timeout,
					details: {
						last_agent_status: lastStatus,
						nudged,
						extended_once: extendedOnce,
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
