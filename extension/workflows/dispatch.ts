import * as path from "node:path";
import { Clock, Effect, Result } from "effect";
import { effectivePaneStyle, supportsFloating } from "../domain/herdr.ts";
import {
	abs,
	phaseDir,
	planPath,
	planReviewPath,
	prDescriptionPath,
	rel,
	tasksDir,
} from "../domain/paths.ts";
import { getRound, roundKey, setRound } from "../domain/rounds.ts";
import {
	allowedKinds,
	expectedRole,
	toolAllowed,
	type DispatchKind,
} from "../domain/state-machine.ts";
import { GateRefused, HerdrError, IllegalKind, type AppError } from "../errors.ts";
import type { Role } from "../lib/types.ts";
import { ROLE_MODE } from "../lib/types.ts";
import { ok, type ToolResult } from "../result.ts";
import { Config } from "../services/config.ts";
import { FileSystem } from "../services/file-system.ts";
import { Herdr } from "../services/herdr.ts";
import { RunStore } from "../services/run-store.ts";
import { Vcs } from "../services/vcs.ts";

export type DispatchParams = {
	kind: DispatchKind;
	task_markdown?: string;
	/** Increment round after CHANGES_REQUIRED (protocol: only then). */
	rework?: boolean;
};

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

/**
 * Write task file, open interactive harness TUI in a Herdr pane (or a
 * floating oneshot popup), wait until idle, submit a short pointer prompt.
 * Refusals are tagged failures only — never ok:false ToolResults.
 */
export const dispatchWorkflow = (
	params: DispatchParams,
	root: string,
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

		const allowed = toolAllowed(state.step, "dispatch_role");
		if (Result.isFailure(allowed)) {
			return yield* allowed.failure;
		}

		const kinds = allowedKinds(state.step);
		if (!kinds.includes(params.kind)) {
			return yield* new IllegalKind({
				step: state.step,
				kind: params.kind,
				allowed: kinds,
			});
		}

		// Rework flag validation
		if (params.rework) {
			const okRework =
				(params.kind === "plan" && state.step === "planning") ||
				(params.kind === "code" && state.step === "coding") ||
				(params.kind === "plan_review" && state.step === "plan_review") ||
				(params.kind === "code_review" && state.step === "code_review");
			// After CHANGES_REQUIRED, step moves back to planning/coding; rework
			// dispatch is plan/code with rework=true.
			if (!okRework && !(params.kind === "plan" || params.kind === "code")) {
				return yield* new GateRefused({
					gate: "rework",
					message:
						"rework=true only valid for plan/code (after CHANGES_REQUIRED) or same-gate re-review",
				});
			}
		}

		const role = expectedRole(params.kind);
		const cfg = yield* config.load(root);

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
			return yield* new GateRefused({
				gate: "round_cap",
				message: `review round cap ${cfg.review_round_cap} exceeded for ${capKey}. Human: workflow_reset_rounds.`,
				details: { gate_key: capKey, cap: cfg.review_round_cap },
			});
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
		yield* fs.mkdir(path.dirname(artifactAbs), { recursive: true });
		if (yield* fs.exists(artifactAbs)) {
			const backupMillis = yield* Clock.currentTimeMillis;
			yield* fs.rename(artifactAbs, `${artifactAbs}.bak.${backupMillis}`);
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

		const taskFileMillis = yield* Clock.currentTimeMillis;
		const taskFile = path.join(
			tasksDir(root),
			`${params.kind}-p${state.phase_index}-r${round}-${taskFileMillis}.md`,
		);
		yield* fs.writeFile(taskFile, body);

		if (role === "reviewer") {
			state.reviewer_tree_fingerprint = yield* vcsSvc.treeFingerprint(
				root,
				state.vcs,
			);
		}

		const paneStyle = effectivePaneStyle(cfg.pane_style, role);
		const prompt = [
			`You are the ${role}.`,
			`Read brief: ${briefAbs}`,
			`Read task: ${rel(taskFile, root)}`,
			`Write artifact exactly at: ${artifactRel}`,
			"Follow the brief. Do not invent paths. Do not commit. Do not edit .apnea/state.json.",
		].join("\n");

		let launch: Record<string, unknown> = {
			mode: ROLE_MODE[role],
			pane_style: cfg.pane_style,
			pane_style_effective: paneStyle.effective,
		};

		if (!state.role_panes) state.role_panes = {};

		if (!(yield* herdr.enabled)) {
			state.pending_artifact = artifactRel;
			state.pending_role = role;
			state.pending_pane_id = null;
			state.pending_pane_label = null;
			state.pending_floating_exit = null;
			yield* store.save(state, root);
			return ok(
				`task written (no Herdr). Launch ${role} yourself; then workflow_wait.`,
				{
					task: rel(taskFile, root),
					artifact: artifactRel,
					round,
					step: state.step,
					launch,
					next: "workflow_wait",
				},
			);
		}

		if (paneStyle.style === "floating") {
			const version = yield* herdr.version;
			if (!supportsFloating(version)) {
				return yield* new HerdrError({
					message:
						"floating panes need herdr >= 0.7.4 — run `herdr update`, or set pane_style=regular",
				});
			}
			if (!(yield* herdr.hasApneaPlugin)) {
				return yield* new HerdrError({
					message: `apnea herdr plugin not linked. Run /apnea setup, or: herdr plugin link ${state.package_root}/herdr-plugin`,
				});
			}
			// Herdr allows one popup. Refuse while a prior floating oneshot is still live.
			if (state.pending_floating_exit) {
				const prevExitAbs = abs(state.pending_floating_exit, root);
				if (!(yield* fs.exists(prevExitAbs))) {
					return yield* new GateRefused({
						gate: "floating_in_flight",
						message:
							"floating oneshot already in flight (popup still open). Call workflow_wait, or dismiss the popup and re-dispatch after it exits",
						details: {
							pending_artifact: state.pending_artifact,
							pending_floating_exit: state.pending_floating_exit,
						},
					});
				}
			}
			const cmdResult = yield* Effect.result(
				config.resolveRoleCmd(cfg, role, "oneshot"),
			);
			if (Result.isFailure(cmdResult)) {
				return yield* new HerdrError({
					message: `floating dispatch requires cmd_oneshot on the role profile: ${cmdResult.failure.message}`,
				});
			}
			const cmd = cmdResult.success;
			const scriptAbs = taskFile.replace(/\.md$/, ".sh");
			const exitAbs = taskFile.replace(/\.md$/, ".exit");
			// Drop stale exit marker so wait cannot see a previous run's code.
			yield* fs.remove(exitAbs);
			yield* herdr.writeFloatingTaskScript(scriptAbs, root, cmd, prompt, exitAbs);
			yield* herdr.openFloatingPane(scriptAbs, root);
			// Popups have no pane id — liveness is the exit file; leave role_panes alone.
			state.pending_pane_id = null;
			state.pending_pane_label = null;
			state.pending_floating_exit = rel(exitAbs, root);
			launch = {
				mode: "oneshot",
				pane_style: cfg.pane_style,
				pane_style_effective: "floating",
				script: rel(scriptAbs, root),
				exit: rel(exitAbs, root),
				cmd,
				prompt,
			};
		} else {
			const prefer = state.role_panes[role] ?? null;
			// Interactive TUI: open harness, wait idle, submit pointer via pane run.
			const cmd = yield* config.resolveRoleCmd(cfg, role, "interactive");
			const r = yield* herdr.runInteractivePrompt(role, cmd, prompt, prefer);
			launch = {
				mode: "interactive",
				pane_id: r.pane_id,
				label: r.label,
				reused: r.reused,
				cmd,
				prompt,
				pane_style: cfg.pane_style,
				pane_style_effective: paneStyle.effective,
				prompt_accepted: r.prompt_accepted,
				prompt_attempts: r.prompt_attempts,
				last_status: r.last_status ?? null,
			};
			state.pending_pane_id = r.pane_id;
			state.pending_pane_label = r.label;
			state.pending_floating_exit = null;
			state.role_panes[role] = { pane_id: r.pane_id, label: r.label };
		}

		state.pending_artifact = artifactRel;
		state.pending_role = role;
		yield* store.save(state, root);

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
	});
