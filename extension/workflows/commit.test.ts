import { describe, expect } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { statePath } from "../domain/paths.ts";
import type { RunState } from "../domain/types.ts";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { fakeConfigLayer } from "../test/fake-config.ts";
import { fakeVcsLayer } from "../test/fake-vcs.ts";
import { itEffect } from "../test/it-effect.ts";
import { RunStore, RunStoreLive } from "../services/run-store.ts";
import { commitWorkflow } from "./commit.ts";

const ROOT = "/proj";

function baseState(over: Partial<RunState> = {}): RunState {
	return {
		version: 1,
		slug: "demo",
		step: "committing",
		phase_index: 1,
		phase_count_hint: null,
		rounds: {},
		vcs: "jj",
		allow_dirty: false,
		goal: "g",
		last_error: null,
		pending_artifact: null,
		pending_role: null,
		pending_pane_id: null,
		pending_pane_label: null,
		pending_floating_exit: null,
		role_panes: {},
		package_root: "/pkg",
		reviewer_tree_fingerprint: null,
		current_phase_package:
			".apnea/artifacts/phase-01/round-1/phase-package.md",
		current_code_review:
			".apnea/artifacts/phase-01/round-1/code-review.md",
		...over,
	};
}

function approvedReview(): string {
	return "---\nstatus: done\nverdict: APPROVED\n---\nlooks good\n";
}

function changesRequiredReview(): string {
	return "---\nstatus: done\nverdict: CHANGES_REQUIRED\n---\nfix it\n";
}

function phasePackage(cmds = "echo ok"): string {
	return `# Phase\n\n\`\`\`sh\n${cmds}\n\`\`\`\n`;
}

function seedFiles(state: RunState, files: Record<string, string> = {}) {
	const initial: Record<string, string> = {
		[statePath(ROOT)]: `${JSON.stringify(state, null, 2)}\n`,
		...files,
	};
	return makeFakeFileSystem(initial);
}

function layerOf(
	fakeFs: ReturnType<typeof makeFakeFileSystem>,
	vcsOpts: Parameters<typeof fakeVcsLayer>[0] = {},
	cfgOpts: Parameters<typeof fakeConfigLayer>[0] = {},
) {
	const vcs = fakeVcsLayer(vcsOpts);
	const cfg = fakeConfigLayer(cfgOpts);
	const layer = Layer.mergeAll(
		Layer.provideMerge(RunStoreLive, fakeFs.layer),
		cfg,
		vcs.layer,
	);
	return { layer, vcs: vcs.recorder, fakeFs };
}

describe("commitWorkflow (fake layers)", () => {
	itEffect("wrong step → IllegalTool", () => {
		const state = baseState({ step: "planning" });
		const fs = seedFiles(state);
		const { layer } = layerOf(fs);
		return Effect.gen(function* () {
			const exit = yield* Effect.exit(commitWorkflow({}, ROOT));
			expect(Exit.isFailure(exit)).toBe(true);
			const r = yield* Effect.result(commitWorkflow({}, ROOT));
			expect(r._tag).toBe("Failure");
			if (r._tag === "Failure") {
				expect(r.failure._tag).toBe("IllegalTool");
			}
		}).pipe(Effect.provide(layer));
	});

	itEffect("missing current_code_review → GateRefused", () => {
		const state = baseState({ current_code_review: null });
		const fs = seedFiles(state);
		const { layer } = layerOf(fs);
		return Effect.gen(function* () {
			const r = yield* Effect.result(commitWorkflow({}, ROOT));
			expect(r._tag).toBe("Failure");
			if (r._tag === "Failure") {
				expect(r.failure._tag).toBe("GateRefused");
				expect(r.failure.message).toContain("current_code_review not set");
			}
		}).pipe(Effect.provide(layer));
	});

	itEffect("verdict CHANGES_REQUIRED → GateRefused with details.review", () => {
		const state = baseState();
		const reviewAbs = `${ROOT}/${state.current_code_review}`;
		const pkgAbs = `${ROOT}/${state.current_phase_package}`;
		const fs = seedFiles(state, {
			[reviewAbs]: changesRequiredReview(),
			[pkgAbs]: phasePackage(),
		});
		const { layer } = layerOf(fs);
		return Effect.gen(function* () {
			const r = yield* Effect.result(commitWorkflow({}, ROOT));
			expect(r._tag).toBe("Failure");
			if (r._tag === "Failure" && r.failure._tag === "GateRefused") {
				expect(r.failure.details?.review).toBe(state.current_code_review);
				expect(r.failure.details?.verdict).toBe("CHANGES_REQUIRED");
			} else {
				expect(r._tag).toBe("Failure");
				if (r._tag === "Failure") expect(r.failure._tag).toBe("GateRefused");
			}
		}).pipe(Effect.provide(layer));
	});

	itEffect("package without sh block → ArtifactInvalid", () => {
		const state = baseState();
		const reviewAbs = `${ROOT}/${state.current_code_review}`;
		const pkgAbs = `${ROOT}/${state.current_phase_package}`;
		const fs = seedFiles(state, {
			[reviewAbs]: approvedReview(),
			[pkgAbs]: "# no verify block\n",
		});
		const { layer } = layerOf(fs);
		return Effect.gen(function* () {
			const r = yield* Effect.result(commitWorkflow({}, ROOT));
			expect(r._tag).toBe("Failure");
			if (r._tag === "Failure") {
				expect(r.failure._tag).toBe("ArtifactInvalid");
				expect(r.failure.message).toContain("no verify commands");
			}
		}).pipe(Effect.provide(layer));
	});

	itEffect(
		"verify failure → VerifyFailed + verify.log written + state unchanged",
		() => {
			const state = baseState();
			const reviewAbs = `${ROOT}/${state.current_code_review}`;
			const pkgAbs = `${ROOT}/${state.current_phase_package}`;
			const fs = seedFiles(state, {
				[reviewAbs]: approvedReview(),
				[pkgAbs]: phasePackage(),
			});
			const { layer, vcs, fakeFs } = layerOf(fs, {
				// failing verify (tagged VerifyFailed path — not a ToolResult)
				verify: { ok: Boolean(0), log: "$ false\nexit=1" },
			});
			return Effect.gen(function* () {
				const r = yield* Effect.result(commitWorkflow({}, ROOT));
				expect(r._tag).toBe("Failure");
				if (r._tag === "Failure") {
					expect(r.failure._tag).toBe("VerifyFailed");
					if (r.failure._tag === "VerifyFailed") {
						expect(r.failure.commands.length).toBeGreaterThan(0);
						expect(r.failure.outputs[0]).toContain("exit=1");
					}
				}
				// verify.log next to review
				const vlog = `${ROOT}/.apnea/artifacts/phase-01/round-1/verify.log`;
				expect(fakeFs.files.has(vlog)).toBe(true);
				expect(fakeFs.files.get(vlog)).toContain("exit=1");
				// no commit recorded
				expect(vcs.commits.length).toBe(0);
				// state unchanged
				const store = yield* RunStore;
				const after = yield* store.require(ROOT);
				expect(after.step).toBe("committing");
				expect(after.phase_index).toBe(1);
				expect(after.current_code_review).toBe(state.current_code_review);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect("verify success → commit recorded, state advances", () => {
		const state = baseState();
		const reviewAbs = `${ROOT}/${state.current_code_review}`;
		const pkgAbs = `${ROOT}/${state.current_phase_package}`;
		const fs = seedFiles(state, {
			[reviewAbs]: approvedReview(),
			[pkgAbs]: phasePackage(),
		});
		const { layer, vcs } = layerOf(fs, {
			verify: { ok: true, log: "$ echo ok\nexit=0\n" },
		});
		return Effect.gen(function* () {
			const result = yield* commitWorkflow({}, ROOT);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data?.step).toBe("phase_packaging");
				expect(result.data?.phase_index).toBe(2);
				expect(result.data?.vcs_detail).toBe("jj describe + new");
				expect(String(result.data?.verify_log)).toContain("verify.log");
			}
			expect(vcs.commits.length).toBe(1);
			expect(vcs.bookmarks.length).toBe(0);
			const store = yield* RunStore;
			const after = yield* store.require(ROOT);
			expect(after.step).toBe("phase_packaging");
			expect(after.phase_index).toBe(2);
			expect(after.current_phase_package).toBeNull();
			expect(after.current_code_review).toBeNull();
		}).pipe(Effect.provide(layer));
	});

	itEffect(
		"no_remaining_phases on jj → finishing + bookmark recorded",
		() => {
			const state = baseState({ vcs: "jj" });
			const reviewAbs = `${ROOT}/${state.current_code_review}`;
			const pkgAbs = `${ROOT}/${state.current_phase_package}`;
			const fs = seedFiles(state, {
				[reviewAbs]: approvedReview(),
				[pkgAbs]: phasePackage(),
			});
			const { layer, vcs } = layerOf(fs);
			return Effect.gen(function* () {
				const result = yield* commitWorkflow(
					{ no_remaining_phases: true },
					ROOT,
				);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.step).toBe("finishing");
					expect(result.data?.next).toEqual([
						"dispatch_role kind=pr_description",
					]);
				}
				expect(vcs.bookmarks).toEqual([{ root: ROOT, slug: "demo" }]);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect("no_remaining_phases on git → finishing, no bookmark", () => {
		const state = baseState({ vcs: "git" });
		const reviewAbs = `${ROOT}/${state.current_code_review}`;
		const pkgAbs = `${ROOT}/${state.current_phase_package}`;
		const fs = seedFiles(state, {
			[reviewAbs]: approvedReview(),
			[pkgAbs]: phasePackage(),
		});
		const { layer, vcs } = layerOf(fs, { commitDetail: "git commit" });
		return Effect.gen(function* () {
			const result = yield* commitWorkflow(
				{ no_remaining_phases: true },
				ROOT,
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data?.step).toBe("finishing");
				expect(result.data?.vcs_detail).toBe("git commit");
			}
			expect(vcs.bookmarks.length).toBe(0);
		}).pipe(Effect.provide(layer));
	});
});
