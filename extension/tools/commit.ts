import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../lib/config.ts";
import { asVerdict, readArtifact } from "../lib/frontmatter.ts";
import { abs, phaseDir } from "../lib/paths.ts";
// phaseDir used for package fallback
import { Result } from "effect";
import { toToolResult } from "../errors.ts";
import { err, ok } from "../lib/result.ts";
import { toolAllowed } from "../lib/state-machine.ts";
import { requireState, saveState } from "../lib/state.ts";
import type { ToolResult } from "../lib/types.ts";
import {
	commitPhase,
	extractVerifyCommands,
	runVerifyCommands,
	setJjBookmarkAtTerminus,
} from "../lib/vcs.ts";

export function workflowCommitPhase(params: {
	message?: string;
	/** When true and no more phases, advance to finishing instead of phase_packaging */
	no_remaining_phases?: boolean;
}): ToolResult {
	const root = process.cwd();
	let state;
	try {
		state = requireState(root);
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
	const allowed = toolAllowed(state.step, "workflow_commit_phase");
	if (Result.isFailure(allowed)) return toToolResult(allowed.failure);

	if (state.step !== "committing") {
		return err(`step is ${state.step}, need committing`, {
			legal_next: ["workflow_status"],
		});
	}

	const reviewRel = state.current_code_review;
	if (!reviewRel) {
		return err("current_code_review not set — complete code_review first");
	}
	const reviewAbs = abs(reviewRel, root);
	const fm = readArtifact(reviewAbs);
	const verdict = asVerdict(fm?.verdict);
	if (verdict !== "APPROVED") {
		return err(
			`commit refused: code review verdict is ${fm?.verdict ?? "missing"} (need APPROVED)`,
			{ data: { review: reviewRel } },
		);
	}

	const pkgRel =
		state.current_phase_package ??
		path.relative(
			root,
			path.join(phaseDir(state.phase_index, 1, root), "phase-package.md"),
		);
	const pkgAbs = abs(pkgRel, root);
	if (!fs.existsSync(pkgAbs)) {
		return err(`phase package missing: ${pkgRel}`);
	}
	const pkgText = fs.readFileSync(pkgAbs, "utf8");
	const cmds = extractVerifyCommands(pkgText);
	if (!cmds.length) {
		return err("no verify commands found in phase package (need ```sh block)");
	}

	let cfg;
	try {
		cfg = loadConfig(root);
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
	const verifyTimeout = cfg.timeouts_ms.verify ?? 900_000;
	const verify = runVerifyCommands(root, cmds, verifyTimeout);

	const verifyLog = path.join(
		phaseDir(state.phase_index, 1, root),
		"verify.log",
	);
	// prefer round from review path
	const reviewDir = path.dirname(reviewAbs);
	const vlog = path.join(reviewDir, "verify.log");
	fs.mkdirSync(path.dirname(vlog), { recursive: true });
	fs.writeFileSync(vlog, verify.log + "\n", "utf8");
	void verifyLog;

	if (!verify.ok) {
		return err("verify commands failed — commit refused", {
			data: {
				verify_log: path.relative(root, vlog),
				log_tail: verify.log.slice(-2000),
			},
		});
	}

	const message =
		params.message?.trim() ||
		`feat: apnea phase ${state.phase_index} (${state.slug})`;

	const c = commitPhase(root, state.vcs, message);
	if (!c.ok) {
		return err(`vcs commit failed: ${c.detail}`);
	}

	// advance
	if (params.no_remaining_phases) {
		state.step = "finishing";
		if (state.vcs === "jj") {
			setJjBookmarkAtTerminus(root, state.slug);
		}
	} else {
		state.phase_index += 1;
		state.step = "phase_packaging";
		state.current_phase_package = null;
		state.current_code_review = null;
	}
	state.last_error = null;
	saveState(state, root);

	return ok(`committed phase; step → ${state.step}`, {
		vcs_detail: c.detail,
		verify_log: path.relative(root, vlog),
		step: state.step,
		phase_index: state.phase_index,
		next:
			state.step === "finishing"
				? ["dispatch_role kind=pr_description"]
				: ["dispatch_role kind=phase_package"],
	});
}
