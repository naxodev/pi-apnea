import * as path from "node:path";
import { loadConfig } from "../lib/config.ts";
import {
	asVerdict,
	isCompleteArtifact,
	readArtifact,
} from "../lib/frontmatter.ts";
import { abs, herdrEnabled, paneGet, sleepMs } from "../lib/herdr-wait.ts";
import { err, ok } from "../lib/result.ts";
import {
	assertToolAllowed,
	stepAfterArtifact,
	type DispatchKind,
} from "../lib/state-machine.ts";
import { requireState, saveState } from "../lib/state.ts";
import type { ToolResult } from "../lib/types.ts";
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

export function workflowWait(params: {
	timeout_ms?: number;
	poll_ms?: number;
}): ToolResult {
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

	const deadline = Date.now() + timeout;
	let lastStatus = "waiting";

	while (Date.now() < deadline) {
		const fm = readArtifact(artifactAbs);
		if (isCompleteArtifact(fm, { requireVerdict })) {
			// reviewer dirty-tree detect (file content)
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

		// liveness: exact pane id for this dispatch (from state, not label scan)
		if (herdrEnabled() && state.pending_pane_id) {
			const info = paneGet(state.pending_pane_id);
			lastStatus = info.ok ? (info.agent_status ?? "unknown") : "pane_missing";
		}

		sleepMs(poll);
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
