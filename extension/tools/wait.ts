import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { loadConfig } from "../lib/config.ts";
import {
	asVerdict,
	isCompleteArtifact,
	readArtifact,
} from "../lib/frontmatter.ts";
import {
	abs,
	herdrEnabled,
	paneGet,
	sleep,
} from "../lib/herdr-wait.ts";
import { err, ok } from "../lib/result.ts";
import {
	assertToolAllowed,
	stepAfterArtifact,
	type DispatchKind,
} from "../lib/state-machine.ts";
import { requireState, saveState } from "../lib/state.ts";
import type { Role, ToolResult } from "../lib/types.ts";
import { treeFingerprint } from "../lib/vcs.ts";

/** Roles that run as cold oneshot processes (exit when done). */
const ONESHOT_ROLES: Role[] = ["planner", "reviewer"];

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
 */
export async function workflowWait(
	params: WaitParams,
	hooks: WaitHooks = {},
): Promise<ToolResult> {
	const root = process.cwd();
	let state;
	try {
		state = requireState(root);
		assertToolAllowed(state.step, "workflow_wait");
	} catch (e) {
		const errObj = e as Error & { legal_next?: string[] };
		return err(errObj.message, { legal_next: errObj.legal_next });
	}

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
	const isOneshot =
		state.pending_role != null && ONESHOT_ROLES.includes(state.pending_role);

	const deadline = Date.now() + timeout;
	let lastStatus = "waiting";
	let idleShellPolls = 0;
	const started = Date.now();
	// grace: don't fail-fast until role has had a few seconds to start
	const graceMs = 8_000;
	// oneshot: after process is shell-only for this many polls, fail
	const deadPollsNeeded = 3;

	hooks.onUpdate?.({
		content: [
			{
				type: "text",
				text: `waiting for ${state.pending_artifact} (timeout ${Math.round(timeout / 1000)}s)…`,
			},
		],
	});

	while (Date.now() < deadline) {
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

			const next = stepAfterArtifact(kind, fm!.verdict);
			if (typeof next === "object") {
				return err(next.error, { data: { artifact: state.pending_artifact } });
			}

			if (kind === "phase_package") {
				state.current_phase_package = state.pending_artifact;
			}
			if (kind === "code_review") {
				state.current_code_review = state.pending_artifact;
			}

			const verdict = asVerdict(fm!.verdict);
			state.step = next;
			state.pending_artifact = null;
			state.pending_role = null;
			state.pending_pane_id = null;
			state.pending_pane_label = null;
			state.reviewer_tree_fingerprint = null;
			state.last_error = null;
			saveState(state, root);

			return ok(`artifact ready; step → ${next}`, {
				artifact: path.relative(root, artifactAbs),
				kind,
				verdict,
				nits: fm!.nits ?? null,
				step: next,
				legal_next:
					next === "committing"
						? ["workflow_commit_phase"]
						: next === "done"
							? ["workflow_status"]
							: ["dispatch_role", "workflow_status"],
			});
		}

		// liveness + oneshot death detection
		if (herdrEnabled() && state.pending_pane_id) {
			const info = paneGet(state.pending_pane_id);
			if (!info.ok) {
				lastStatus = "pane_missing";
				if (Date.now() - started > graceMs) {
					state.last_error = `role pane missing while waiting for ${state.pending_artifact}`;
					saveState(state, root);
					return err(
						`role pane gone and artifact incomplete: ${state.pending_artifact}`,
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
				if (isOneshot && Date.now() - started > graceMs) {
					// Death signal = foreground is only a shell (claude/pi process exited).
					// Do NOT use agent_status alone — oneshot can report idle mid-run.
					const names = paneForegroundNames(state.pending_pane_id);
					if (looksLikeShellOnly(names)) {
						const again = readArtifact(artifactAbs);
						if (!isCompleteArtifact(again, { requireVerdict })) {
							idleShellPolls += 1;
							if (idleShellPolls >= deadPollsNeeded) {
								state.last_error = `oneshot role finished without artifact ${state.pending_artifact}`;
								saveState(state, root);
								return err(
									`oneshot ${state.pending_role} finished without writing ${state.pending_artifact}`,
									{
										data: {
											last_agent_status: lastStatus,
											foreground: names,
											hint: "check profile allowedTools / pane output; re-dispatch same round",
										},
									},
								);
							}
						}
					} else {
						idleShellPolls = 0;
					}
				}
			}
		}

		const elapsed = Math.round((Date.now() - started) / 1000);
		hooks.onUpdate?.({
			content: [
				{
					type: "text",
					text: `waiting ${elapsed}s for ${state.pending_artifact} (agent=${lastStatus})…`,
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

	state.last_error = `timeout waiting for ${state.pending_artifact}`;
	saveState(state, root);
	return err(
		`timeout after ${timeout}ms waiting for ${state.pending_artifact}`,
		{
			data: {
				last_agent_status: lastStatus,
				hint: "escalate to human; re-dispatch same round after investigate",
			},
		},
	);
}
