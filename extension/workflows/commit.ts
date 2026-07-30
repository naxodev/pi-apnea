import * as path from "node:path";
import { Effect, Result } from "effect";
import { asVerdict, parseFrontMatter } from "../domain/frontmatter.ts";
import { abs, phaseDir, rel } from "../domain/paths.ts";
import { nextAfter, toolAllowed } from "../domain/state-machine.ts";
import { extractVerifyCommands } from "../domain/verify-commands.ts";
import {
	ArtifactInvalid,
	GateRefused,
	VerifyFailed,
	type AppError,
} from "../errors.ts";
import { ok, type ToolResult } from "../result.ts";
import { Config } from "../services/config.ts";
import { FileSystem } from "../services/file-system.ts";
import { RunStore } from "../services/run-store.ts";
import { Vcs } from "../services/vcs.ts";

export type CommitParams = {
	message?: string;
	/** When true and no more phases, advance to finishing instead of phase_packaging */
	no_remaining_phases?: boolean;
};

/**
 * Require APPROVED code review, run phase package verify commands,
 * jj/git commit, advance phase. Refusals are tagged failures only.
 */
export const commitWorkflow = (
	params: CommitParams,
	root: string,
): Effect.Effect<
	ToolResult,
	AppError,
	FileSystem | RunStore | Config | Vcs
> =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		const fs = yield* FileSystem;
		const config = yield* Config;
		const vcs = yield* Vcs;

		const state = yield* store.require(root);

		const allowed = toolAllowed(state.step, "workflow_commit_phase");
		if (Result.isFailure(allowed)) {
			return yield* allowed.failure;
		}

		const reviewRel = state.current_code_review;
		if (!reviewRel) {
			return yield* new GateRefused({
				gate: "commit",
				message: "current_code_review not set — complete code_review first",
			});
		}

		const reviewAbs = abs(reviewRel, root);
		const reviewPresent = yield* fs.exists(reviewAbs);
		let fm: ReturnType<typeof parseFrontMatter> = null;
		if (reviewPresent) {
			const reviewText = yield* fs.readFile(reviewAbs);
			fm = parseFrontMatter(reviewText);
		}
		const verdict = asVerdict(fm?.verdict);
		if (verdict !== "APPROVED") {
			return yield* new GateRefused({
				gate: "commit",
				message: `commit refused: code review verdict is ${fm?.verdict ?? "missing"} (need APPROVED)`,
				details: {
					review: reviewRel,
					verdict: fm?.verdict ?? "missing",
				},
			});
		}

		const pkgRel =
			state.current_phase_package ??
			rel(
				path.join(phaseDir(state.phase_index, 1, root), "phase-package.md"),
				root,
			);
		const pkgAbs = abs(pkgRel, root);
		const pkgPresent = yield* fs.exists(pkgAbs);
		if (!pkgPresent) {
			return yield* new GateRefused({
				gate: "commit",
				message: `phase package missing: ${pkgRel}`,
				details: { package: pkgRel },
			});
		}
		const pkgText = yield* fs.readFile(pkgAbs);
		const cmds = extractVerifyCommands(pkgText);
		if (!cmds.length) {
			return yield* new ArtifactInvalid({
				artifact: pkgRel,
				message:
					"no verify commands found in phase package (need ```sh block)",
			});
		}

		const cfg = yield* config.load(root);
		const verifyTimeout = cfg.timeouts_ms.verify ?? 900_000;
		const verify = yield* vcs.runVerify(root, cmds, verifyTimeout);

		const vlog = path.join(path.dirname(reviewAbs), "verify.log");
		yield* fs.mkdir(path.dirname(vlog), { recursive: true });
		yield* fs.writeFile(vlog, `${verify.log}\n`);

		if (!verify.ok) {
			return yield* new VerifyFailed({
				commands: cmds,
				outputs: [verify.log.slice(-2000)],
				// `outputs` is a tail — point the caller at the full log on disk.
				verify_log: rel(vlog, root),
			});
		}

		const message =
			params.message?.trim() ||
			`feat: apnea phase ${state.phase_index} (${state.slug})`;

		const detail = yield* vcs.commitPhase(root, state.vcs, message);

		if (params.no_remaining_phases) {
			state.step = "finishing";
			if (state.vcs === "jj") {
				yield* vcs.setBookmarkAtTerminus(root, state.slug);
			}
		} else {
			state.phase_index += 1;
			state.step = "phase_packaging";
			state.current_phase_package = null;
			state.current_code_review = null;
		}
		state.last_error = null;
		yield* store.save(state, root);

		return ok(
			`committed phase; step → ${state.step}`,
			{
				vcs_detail: detail,
				verify_log: rel(vlog, root),
				step: state.step,
				phase_index: state.phase_index,
				next:
					state.step === "finishing"
						? ["dispatch_role kind=pr_description"]
						: ["dispatch_role kind=phase_package"],
			},
			nextAfter(state.step),
		);
	});
