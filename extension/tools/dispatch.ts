import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, resolveRoleCmd } from "../lib/config.ts";
import {
	ensureDirForFile,
	phaseDir,
	planPath,
	planReviewPath,
	prDescriptionPath,
	rel,
	tasksDir,
} from "../lib/paths.ts";
import { herdrEnabled, runInteractivePrompt } from "../lib/herdr.ts";
import { err, ok } from "../lib/result.ts";
import {
	allowedKinds,
	assertToolAllowed,
	expectedRole,
	type DispatchKind,
} from "../lib/state-machine.ts";
import {
	getRound,
	requireState,
	roundKey,
	saveState,
	setRound,
} from "../lib/state.ts";
import type { Role, ToolResult } from "../lib/types.ts";
import { ROLE_MODE } from "../lib/types.ts";
import { treeFingerprint } from "../lib/vcs.ts";

function taskBody(opts: {
	kind: DispatchKind;
	role: Role;
	goal: string;
	artifactRel: string;
	briefAbs: string;
	extra: string;
}): string {
	return `# Dispatch: ${opts.role} (${opts.kind})

## Role

${opts.role}

## Brief

Read and follow:

\`${opts.briefAbs}\`

## Goal

${opts.goal}

## Artifact

Write **exactly**:

\`${opts.artifactRel}\`

Front-matter must include \`status: done\`. Review artifacts also need \`verdict: APPROVED | CHANGES_REQUIRED\` and optional \`nits\`.

## Details

${opts.extra}

## Rules

- Do not invent artifact paths.
- Do not edit \`.apnea/state.json\`.
- Do not commit / push.
`;
}

function codeReviewRoundKey(phaseIndex: number): string {
	return roundKey(phaseIndex, "code_review");
}

export function workflowDispatch(params: {
	kind: DispatchKind;
	task_markdown?: string;
	/** Increment round after CHANGES_REQUIRED (protocol: only then). */
	rework?: boolean;
}): ToolResult {
	const root = process.cwd();
	let state;
	try {
		state = requireState(root);
		assertToolAllowed(state.step, "dispatch_role");
	} catch (e) {
		const errObj = e as Error & { legal_next?: string[] };
		return err(errObj.message, { legal_next: errObj.legal_next });
	}

	const kinds = allowedKinds(state.step);
	if (!kinds.includes(params.kind)) {
		return err(
			`kind=${params.kind} not allowed at step=${state.step}. allowed: ${kinds.join(", ")}`,
			{ legal_next: ["dispatch_role with allowed kind", "workflow_status"] },
		);
	}

	// Rework flag validation
	if (params.rework) {
		const okRework =
			(params.kind === "plan" && state.step === "planning") ||
			(params.kind === "code" && state.step === "coding") ||
			(params.kind === "plan_review" && state.step === "plan_review") ||
			(params.kind === "code_review" && state.step === "code_review");
		// After CHANGES_REQUIRED, step moves back to planning/coding; rework dispatch is plan/code with rework=true
		if (!okRework && !(params.kind === "plan" || params.kind === "code")) {
			return err(
				"rework=true only valid for plan/code (after CHANGES_REQUIRED) or same-gate re-review",
			);
		}
	}

	const role = expectedRole(params.kind);
	let cfg;
	try {
		cfg = loadConfig(root);
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}

	// --- Round numbers (increment ONLY on rework after CHANGES_REQUIRED) ---
	let round = 1;
	if (params.kind === "plan" || params.kind === "plan_review") {
		const key = roundKey(0, "plan_review");
		if (params.rework && params.kind === "plan") {
			// starting a new plan revision after CHANGES_REQUIRED → next review round
			setRound(state, key, getRound(state, key) + 1);
		} else if (!state.rounds[key]) {
			setRound(state, key, 1);
		}
		round = getRound(state, key);
	} else if (
		params.kind === "code" ||
		params.kind === "code_review" ||
		params.kind === "phase_package"
	) {
		const key = codeReviewRoundKey(state.phase_index);
		if (params.rework && params.kind === "code") {
			setRound(state, key, getRound(state, key) + 1);
		} else if (!state.rounds[key]) {
			setRound(state, key, 1);
		}
		round = getRound(state, key);
	}

	// Cap: number of review rounds (rework count)
	const capKey =
		params.kind === "plan" || params.kind === "plan_review"
			? roundKey(0, "plan_review")
			: codeReviewRoundKey(state.phase_index);
	if (
		(params.kind === "plan" ||
			params.kind === "code" ||
			params.kind === "plan_review" ||
			params.kind === "code_review") &&
		getRound(state, capKey) > cfg.review_round_cap
	) {
		return err(
			`review round cap ${cfg.review_round_cap} exceeded for ${capKey}. Human: workflow_reset_rounds.`,
		);
	}

	// Resolve artifact path
	let artifactAbs: string;
	let extra = params.task_markdown?.trim() || "";

	switch (params.kind) {
		case "plan":
			artifactAbs = planPath(root);
			if (!extra) {
				extra = `Produce full plan for goal. Vertical phases with acceptance + verify commands.\nIf rework, address plan-review under .apnea/artifacts/plan-review/.`;
			}
			break;
		case "plan_review":
			artifactAbs = planReviewPath(round, root);
			extra =
				extra ||
				`Review plan at \`${rel(planPath(root), root)}\`.\nWrite verdict front-matter.`;
			break;
		case "phase_package": {
			const d = phaseDir(state.phase_index, 1, root);
			artifactAbs = path.join(d, "phase-package.md");
			extra =
				extra ||
				`Emit phase package for phase ${state.phase_index} only from approved plan \`${rel(planPath(root), root)}\`.`;
			break;
		}
		case "code": {
			const d = phaseDir(state.phase_index, round, root);
			artifactAbs = path.join(d, "coder-result.md");
			const pkg =
				state.current_phase_package ??
				rel(
					path.join(phaseDir(state.phase_index, 1, root), "phase-package.md"),
					root,
				);
			extra =
				extra ||
				`Implement phase package \`${pkg}\` only.\nOn rework, read latest code-review and fix.`;
			break;
		}
		case "code_review": {
			const d = phaseDir(state.phase_index, round, root);
			artifactAbs = path.join(d, "code-review.md");
			const pkg =
				state.current_phase_package ??
				rel(
					path.join(phaseDir(state.phase_index, 1, root), "phase-package.md"),
					root,
				);
			const coder = rel(path.join(d, "coder-result.md"), root);
			extra =
				extra ||
				`1) Compare phase package \`${pkg}\` to plan.\n2) Review code vs package.\n3) Check coder result \`${coder}\`.`;
			break;
		}
		case "pr_description":
			artifactAbs = prDescriptionPath(root);
			extra = extra || "Write PR description summarizing all phases.";
			break;
	}

	// clear-before-dispatch
	ensureDirForFile(artifactAbs);
	if (fs.existsSync(artifactAbs)) {
		fs.renameSync(artifactAbs, `${artifactAbs}.bak.${Date.now()}`);
	}

	const artifactRel = rel(artifactAbs, root);
	const briefAbs = path.join(state.package_root, "briefs", `${role}.md`);
	const body = taskBody({
		kind: params.kind,
		role,
		goal: state.goal,
		artifactRel,
		briefAbs,
		extra,
	});

	const taskFile = path.join(
		tasksDir(root),
		`${params.kind}-p${state.phase_index}-r${round}-${Date.now()}.md`,
	);
	fs.writeFileSync(taskFile, body, "utf8");

	if (role === "reviewer") {
		state.reviewer_tree_fingerprint = treeFingerprint(root, state.vcs);
	}

	let launch: Record<string, unknown> = { mode: ROLE_MODE[role] };

	if (!state.role_panes) state.role_panes = {};

	if (!herdrEnabled()) {
		state.pending_artifact = artifactRel;
		state.pending_role = role;
		state.pending_pane_id = null;
		state.pending_pane_label = null;
		saveState(state, root);
		return ok(
			`task written (no Herdr). Launch ${role} yourself; then workflow_wait.`,
			{
				task: rel(taskFile, root),
				artifact: artifactRel,
				round,
				step: state.step,
				next: "workflow_wait",
			},
		);
	}

	const prefer = state.role_panes[role] ?? null;

	try {
		// Always interactive TUI: open harness, wait idle, submit pointer via pane run.
		// Never oneshot (`-p`) — that dumps shell output and is not watchable.
		const cmd = resolveRoleCmd(cfg, role, "interactive");
		const prompt = [
			`You are the ${role}.`,
			`Read brief: ${briefAbs}`,
			`Read task: ${rel(taskFile, root)}`,
			`Write artifact exactly at: ${artifactRel}`,
			"Follow the brief. Do not invent paths. Do not commit. Do not edit .apnea/state.json.",
		].join("\n");
		const r = runInteractivePrompt(role, cmd, prompt, prefer);
		launch = {
			mode: "interactive",
			pane_id: r.pane_id,
			label: r.label,
			reused: r.reused,
			cmd,
			prompt,
		};
		state.pending_pane_id = r.pane_id;
		state.pending_pane_label = r.label;
		state.role_panes[role] = { pane_id: r.pane_id, label: r.label };
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e), {
			data: { task: rel(taskFile, root), artifact: artifactRel },
		});
	}

	state.pending_artifact = artifactRel;
	state.pending_role = role;
	saveState(state, root);

	const timeoutKey =
		params.kind === "plan"
			? "planning"
			: params.kind === "plan_review"
				? "plan_review"
				: params.kind === "phase_package"
					? "phase_packaging"
					: params.kind === "code"
						? "coding"
						: params.kind === "code_review"
							? "code_review"
							: "finishing";

	return ok(`dispatched ${params.kind} → ${role} artifact=${artifactRel}`, {
		task: rel(taskFile, root),
		artifact: artifactRel,
		round,
		step: state.step,
		timeout_ms: cfg.timeouts_ms[timeoutKey] ?? cfg.timeouts_ms.default,
		launch,
		next: "workflow_wait",
	});
}
