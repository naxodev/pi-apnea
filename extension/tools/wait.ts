import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { loadConfig } from "../lib/config.ts";
import {
	asVerdict,
	isCompleteArtifact,
	readArtifact,
} from "../lib/frontmatter.ts";
import { readFloatingExit } from "../lib/herdr.ts";
import {
	abs,
	herdrEnabled,
	paneGet,
	paneRun,
	sleep,
} from "../lib/herdr-wait.ts";
import { Result } from "effect";
import { toToolResult } from "../errors.ts";
import { err, ok } from "../lib/result.ts";
import {
	stepAfterArtifact,
	toolAllowed,
	type DispatchKind,
} from "../lib/state-machine.ts";
import { requireState, saveState } from "../lib/state.ts";
import type { FrontMatter, RunState, ToolResult } from "../lib/types.ts";
import { treeFingerprint } from "../lib/vcs.ts";

function inferKind(artifactRel: string): DispatchKind {
	if (artifactRel.endsWith("plan.md") && !artifactRel.includes("plan-review"))
		return "plan";
	if (artifactRel.includes("plan-review")) return "plan_review";
	if (artifactRel.endsWith("phase-package.md")) return "phase_package";
	if (artifactRel.endsWith("coder-result.md")) return "code";
	if (artifactRel.endsWith("code-review.md")) return "code_review";
	if (artifactRel.endsWith("pr-description.md")) return "pr_description";
	throw new Error(`cannot infer dispatch kind from ${artifactRel}`);
}

function paneForegroundNames(paneId: string): string[] {
	try {
		const r = spawnSync("herdr", ["pane", "process-info", "--pane", paneId], {
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		});
		if (r.status !== 0) return [];
		const line =
			(r.stdout ?? "").trim().split(/\n/).filter(Boolean).pop() ?? "";
		const json = JSON.parse(line) as {
			result?: {
				process_info?: {
					foreground_processes?: Array<{
						name?: string;
						argv0?: string;
						cmdline?: string;
					}>;
				};
			};
		};
		const procs = json.result?.process_info?.foreground_processes ?? [];
		return procs.map((p) => p.cmdline || p.argv0 || p.name || "?");
	} catch {
		return [];
	}
}

function looksLikeShellOnly(names: string[]): boolean {
	if (names.length === 0) return false;
	return names.every((n) => {
		const t = n.trim();
		return (
			/^(zsh|bash|sh|fish)$/i.test(t) ||
			t === "-zsh" ||
			t === "-bash" ||
			t === "-sh"
		);
	});
}

function advanceOnComplete(
	state: RunState,
	root: string,
	kind: DispatchKind,
	fm: FrontMatter,
	artifactAbs: string,
	msg = "artifact ready",
): ToolResult {
	if (
		state.pending_role === "reviewer" &&
		state.reviewer_tree_fingerprint != null
	) {
		const now = treeFingerprint(root, state.vcs);
		if (now !== state.reviewer_tree_fingerprint) {
			state.last_error = "reviewer dirtied file tree";
			saveState(state, root);
			return err(
				"reviewer dirty-tree detection: file content changed during review — escalate to human",
				{
					data: {
						before: state.reviewer_tree_fingerprint,
						after: now,
						artifact: state.pending_artifact,
					},
				},
			);
		}
	}

	const next = stepAfterArtifact(kind, fm.verdict);
	if (typeof next === "object") {
		return err(next.error, { data: { artifact: state.pending_artifact } });
	}

	if (kind === "phase_package") {
		state.current_phase_package = state.pending_artifact;
	}
	if (kind === "code_review") {
		state.current_code_review = state.pending_artifact;
	}

	const verdict = asVerdict(fm.verdict);
	state.step = next;
	state.pending_artifact = null;
	state.pending_role = null;
	state.pending_pane_id = null;
	state.pending_pane_label = null;
	state.pending_floating_exit = null;
	state.reviewer_tree_fingerprint = null;
	state.last_error = null;
	saveState(state, root);

	return ok(`${msg}; step → ${next}`, {
		artifact: path.relative(root, artifactAbs),
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
}

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
 * Async wait — yields the event loop between polls so Pi stays responsive
 * and Esc (AbortSignal) can cancel.
 *
 * Recovery (does not immediately escalate):
 * - idle/done without artifact for ≥90s → one nudge prompt into the role pane
 * - still working/blocked at timeout → extend budget once by max(50%, 2m)
 * - idle at final timeout and never nudged → final nudge + 3m grace
 */
export async function workflowWait(
	params: WaitParams,
	hooks: WaitHooks = {},
): Promise<ToolResult> {
	const root = process.cwd();
	let state;
	try {
		state = requireState(root);
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
	const allowed = toolAllowed(state.step, "workflow_wait");
	if (Result.isFailure(allowed)) return toToolResult(allowed.failure);

	if (!state.pending_artifact) {
		return err("no pending_artifact; dispatch_role first");
	}

	let cfg;
	try {
		cfg = loadConfig(root);
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}

	const timeout = params.timeout_ms ?? cfg.timeouts_ms.default ?? 900_000;
	const poll = params.poll_ms ?? 2000;
	const artifactAbs = abs(state.pending_artifact, root);
	const kind = inferKind(state.pending_artifact);
	const requireVerdict = kind === "plan_review" || kind === "code_review";
	let deadline = Date.now() + timeout;
	let lastStatus = "waiting";
	let shellOnlyPolls = 0;
	const started = Date.now();
	const graceMs = 12_000;
	const deadPollsNeeded = 4;
	const idleNudgeAfterMs = 90_000;
	let idleSince: number | null = null;
	let floatingExitSeenAt: number | null = null;
	let nudged = false;
	let extendedOnce = false;
	let finalNudgeGrace = false;
	const floatingFlushMs = 2_000;
	const pendingArtifact = state.pending_artifact;
	const nudgePrompt =
		`You appear idle without writing the required artifact.\n` +
		`Write it now exactly at: ${pendingArtifact}\n` +
		`Front-matter must include status: done` +
		(requireVerdict ? ` and verdict: APPROVED | CHANGES_REQUIRED` : "") +
		`. Follow the brief and task file. Do not invent paths.`;

	const tryNudge = (why: string): void => {
		if (nudged || !herdrEnabled() || !state.pending_pane_id) return;
		nudged = true;
		try {
			paneRun(state.pending_pane_id, nudgePrompt);
			hooks.onUpdate?.({
				content: [
					{
						type: "text",
						text: `${why} — nudged ${state.pending_role} to write ${pendingArtifact}`,
					},
				],
			});
		} catch {
			/* best-effort recovery */
		}
		idleSince = Date.now();
	};

	hooks.onUpdate?.({
		content: [
			{
				type: "text",
				text: `waiting for ${pendingArtifact} (timeout ${Math.round(timeout / 1000)}s)…`,
			},
		],
	});

	while (true) {
		if (hooks.signal?.aborted) {
			state.last_error = "workflow_wait aborted";
			saveState(state, root);
			return err("workflow_wait aborted (Esc / cancel)", {
				data: {
					artifact: state.pending_artifact,
					last_agent_status: lastStatus,
					hint: "re-dispatch same round or wait again after investigate",
				},
			});
		}

		const fm = readArtifact(artifactAbs);
		if (isCompleteArtifact(fm, { requireVerdict })) {
			return advanceOnComplete(
				state,
				root,
				kind,
				fm!,
				artifactAbs,
				nudged ? "artifact ready after nudge" : "artifact ready",
			);
		}

		// Floating oneshot: no pane id — exit file is liveness. Fail closed when the
		// popup dies without a complete artifact instead of hanging until timeout.
		if (state.pending_floating_exit) {
			const exitAbs = abs(state.pending_floating_exit, root);
			const code = readFloatingExit(exitAbs);
			if (code != null) {
				lastStatus = `floating_exit_${code}`;
				floatingExitSeenAt ??= Date.now();
				// Short flush window: oneshot may finish writing as the process exits.
				if (Date.now() - floatingExitSeenAt >= floatingFlushMs) {
					const again = readArtifact(artifactAbs);
					if (isCompleteArtifact(again, { requireVerdict })) {
						return advanceOnComplete(
							state,
							root,
							kind,
							again!,
							artifactAbs,
							"artifact ready (floating oneshot exited)",
						);
					}
					state.pending_floating_exit = null;
					state.last_error = `floating oneshot exited ${code} without ${pendingArtifact}`;
					saveState(state, root);
					return err(
						`floating ${state.pending_role} exited (code ${code}) without writing ${pendingArtifact}`,
						{
							data: {
								exit_code: code,
								last_agent_status: lastStatus,
								hint:
									code === 129
										? "popup received Hangup (dismiss/focus steal) — re-dispatch same round; keep focus on the popup"
										: "inspect oneshot output; re-dispatch same round or set pane_style=regular",
							},
						},
					);
				}
			} else {
				lastStatus = "floating_running";
			}
		}

		if (herdrEnabled() && state.pending_pane_id) {
			const info = paneGet(state.pending_pane_id);
			if (!info.ok) {
				lastStatus = "pane_missing";
				if (Date.now() - started > graceMs) {
					state.last_error = `role pane missing while waiting for ${pendingArtifact}`;
					saveState(state, root);
					return err(
						`role pane gone and artifact incomplete: ${pendingArtifact}`,
						{
							data: {
								last_agent_status: lastStatus,
								hint: "re-dispatch same round after investigate",
							},
						},
					);
				}
			} else {
				lastStatus = info.agent_status ?? "unknown";

				if (lastStatus === "idle" || lastStatus === "done") {
					if (idleSince == null) idleSince = Date.now();
					else if (
						Date.now() - idleSince >= idleNudgeAfterMs &&
						Date.now() - started > graceMs
					) {
						tryNudge("idle stall");
					}
				} else {
					idleSince = null;
				}

				if (Date.now() - started > graceMs) {
					const names = paneForegroundNames(state.pending_pane_id);
					if (looksLikeShellOnly(names)) {
						const again = readArtifact(artifactAbs);
						if (!isCompleteArtifact(again, { requireVerdict })) {
							shellOnlyPolls += 1;
							if (shellOnlyPolls >= deadPollsNeeded) {
								state.last_error = `role pane shell-only without artifact ${pendingArtifact}`;
								saveState(state, root);
								return err(
									`${state.pending_role} harness exited without writing ${pendingArtifact}`,
									{
										data: {
											last_agent_status: lastStatus,
											foreground: names,
											hint: "check pane transcript; re-dispatch same round",
										},
									},
								);
							}
						}
					} else {
						shellOnlyPolls = 0;
					}
				}
			}
		}

		if (Date.now() >= deadline) {
			// Still working: extend once.
			if (
				!extendedOnce &&
				(lastStatus === "working" || lastStatus === "blocked")
			) {
				extendedOnce = true;
				const extra = Math.max(Math.floor(timeout * 0.5), 120_000);
				deadline = Date.now() + extra;
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
				tryNudge("timeout idle");
				deadline = Date.now() + 180_000;
				continue;
			}

			break;
		}

		const elapsed = Math.round((Date.now() - started) / 1000);
		hooks.onUpdate?.({
			content: [
				{
					type: "text",
					text: `waiting ${elapsed}s for ${pendingArtifact} (agent=${lastStatus})…`,
				},
			],
		});

		try {
			await sleep(poll, hooks.signal);
		} catch {
			state.last_error = "workflow_wait aborted";
			saveState(state, root);
			return err("workflow_wait aborted (Esc / cancel)", {
				data: {
					artifact: state.pending_artifact,
					last_agent_status: lastStatus,
				},
			});
		}
	}

	state.last_error = `timeout waiting for ${pendingArtifact}`;
	saveState(state, root);
	return err(`timeout after ${timeout}ms waiting for ${pendingArtifact}`, {
		data: {
			last_agent_status: lastStatus,
			nudged,
			extended_once: extendedOnce,
			hint: "inspect pane transcript; re-dispatch same round or nudge via herdr pane run",
		},
	});
}
