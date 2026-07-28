import { Effect, Layer } from "effect";
import { describe, expect } from "bun:test";
import * as path from "node:path";
import { statePath } from "../domain/paths.ts";
import type { ApneaConfig, RunState } from "../domain/types.ts";
import { HerdrError, toToolResult } from "../errors.ts";
import { expectFailure } from "../test/expect-failure.ts";
import { fakeConfigLayer } from "../test/fake-config.ts";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { fakeHerdrLayer } from "../test/fake-herdr.ts";
import { fakeVcsLayer } from "../test/fake-vcs.ts";
import { itEffect } from "../test/it-effect.ts";
import { RunStoreLive } from "../services/run-store.ts";
import { dispatchWorkflow } from "./dispatch.ts";

const ROOT = "/proj";

const FLOATING_CFG: ApneaConfig = {
	profiles: { pi: { cmd_interactive: ["pi"], cmd_oneshot: ["pi", "-p"] } },
	roles: {
		planner: { profile: "pi" },
		reviewer: { profile: "pi" },
		coder: { profile: "pi" },
	},
	review_round_cap: 3,
	timeouts_ms: { verify: 900_000 },
	pane_style: "floating",
};

/** Floating dispatch with no cmd_oneshot → the resolveRoleCmd refusal at the floating branch. */
const FLOATING_NO_ONESHOT: ApneaConfig = {
	...FLOATING_CFG,
	profiles: { pi: { cmd_interactive: ["pi"] } },
};

/** Regular dispatch with no cmd_interactive → the resolveRoleCmd refusal at the interactive branch. */
const NO_INTERACTIVE_CFG: ApneaConfig = {
	...FLOATING_CFG,
	profiles: { pi: { cmd_oneshot: ["pi", "-p"] } },
	pane_style: "regular",
};

function baseState(overrides: Partial<RunState> = {}): RunState {
	return {
		version: 1,
		slug: "ex",
		step: "planning",
		phase_index: 1,
		phase_count_hint: null,
		rounds: {},
		vcs: "jj",
		allow_dirty: false,
		goal: "goal text",
		last_error: null,
		pending_artifact: null,
		pending_role: null,
		pending_pane_id: null,
		pending_pane_label: null,
		pending_floating_exit: null,
		role_panes: {},
		package_root: "/pkg",
		reviewer_tree_fingerprint: null,
		current_phase_package: null,
		current_code_review: null,
		...overrides,
	};
}

function seedFs(state: RunState, files: Record<string, string> = {}) {
	return makeFakeFileSystem({
		[statePath(ROOT)]: `${JSON.stringify(state, null, 2)}\n`,
		...files,
	});
}

function layerOf(
	fakeFs: ReturnType<typeof makeFakeFileSystem>,
	opts: {
		vcs?: Parameters<typeof fakeVcsLayer>[0];
		cfg?: Parameters<typeof fakeConfigLayer>[0];
		herdr?: Parameters<typeof fakeHerdrLayer>[0];
	} = {},
) {
	const vcs = fakeVcsLayer(opts.vcs ?? {});
	const cfg = fakeConfigLayer(opts.cfg ?? {});
	const herdr = fakeHerdrLayer(opts.herdr ?? {});
	const layer = Layer.mergeAll(
		Layer.provideMerge(RunStoreLive, fakeFs.layer),
		cfg,
		vcs.layer,
		herdr.layer,
	);
	return { layer, vcs: vcs.recorder, herdr: herdr.recorder, fakeFs };
}

function savedState(fakeFs: ReturnType<typeof makeFakeFileSystem>): RunState {
	return JSON.parse(fakeFs.files.get(statePath(ROOT))!) as RunState;
}

function assertTaskRef(
	details: Record<string, unknown> | undefined,
	fakeFs: ReturnType<typeof makeFakeFileSystem>,
): void {
	expect(details?.artifact).toBe(".apnea/artifacts/plan.md");
	const task = details?.task;
	expect(typeof task).toBe("string");
	expect(task as string).toMatch(/^\.apnea\/tasks\/plan-p1-r1-\d+\.md$/);
	// The whole point: the orchestrator can find the file dispatch orphaned.
	expect(fakeFs.files.has(path.join(ROOT, task as string))).toBe(true);
}

describe("dispatchWorkflow (fake layers)", () => {
	itEffect("wrong step → IllegalTool", () => {
		const fsFake = seedFs(baseState({ step: "committing" }));
		const { layer } = layerOf(fsFake);
		return Effect.gen(function* () {
			const r = yield* Effect.result(dispatchWorkflow({ kind: "plan" }, ROOT));
			expectFailure(r, "IllegalTool");
		}).pipe(Effect.provide(layer));
	});

	itEffect("kind not legal for step → IllegalKind carries the allowed set", () => {
		const fsFake = seedFs(baseState({ step: "planning" }));
		const { layer } = layerOf(fsFake);
		return Effect.gen(function* () {
			const r = yield* Effect.result(dispatchWorkflow({ kind: "code" }, ROOT));
			const e = expectFailure(r, "IllegalKind");
			expect(e.allowed).toEqual(["plan"]);
		}).pipe(Effect.provide(layer));
	});

	itEffect(
		"no-herdr path writes the task file and sets pending fields with pending_pane_id null",
		() => {
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: { enabled: false },
			});
			return Effect.gen(function* () {
				const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.next).toBe("workflow_wait");
					const taskPath = String(result.data?.task);
					expect(fakeFs.files.has(`${ROOT}/${taskPath}`)).toBe(true);
				}
				const saved = savedState(fakeFs);
				// An operator must be able to launch the role by hand — a stray
				// pane id here would point at a pane Herdr never opened.
				expect(saved.pending_artifact).toBe(".apnea/artifacts/plan.md");
				expect(saved.pending_role).toBe("planner");
				expect(saved.pending_pane_id).toBeNull();
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"rework:true on code bumps phase-01/code_review by one",
		() => {
			const fsFake = seedFs(
				baseState({ step: "coding", rounds: { "phase-01/code_review": 2 } }),
			);
			const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } });
			return Effect.gen(function* () {
				const result = yield* dispatchWorkflow(
					{ kind: "code", rework: true },
					ROOT,
				);
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.data?.round).toBe(3);
				expect(savedState(fakeFs).rounds["phase-01/code_review"]).toBe(3);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"a non-rework code dispatch does not bump the round (round inflation would burn the cap)",
		() => {
			const fsFake = seedFs(
				baseState({ step: "coding", rounds: { "phase-01/code_review": 2 } }),
			);
			const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } });
			return Effect.gen(function* () {
				const result = yield* dispatchWorkflow({ kind: "code" }, ROOT);
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.data?.round).toBe(2);
				expect(savedState(fakeFs).rounds["phase-01/code_review"]).toBe(2);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect("round over review_round_cap → GateRefused round_cap", () => {
		const fsFake = seedFs(
			baseState({ step: "coding", rounds: { "phase-01/code_review": 4 } }),
		);
		const { layer } = layerOf(fsFake, { herdr: { enabled: false } });
		return Effect.gen(function* () {
			const r = yield* Effect.result(dispatchWorkflow({ kind: "code" }, ROOT));
			const e = expectFailure(r, "GateRefused");
			expect(e.gate).toBe("round_cap");
		}).pipe(Effect.provide(layer));
	});

	itEffect(
		"reviewer dispatch records reviewer_tree_fingerprint (dirty-reviewer check is worthless without it)",
		() => {
			const fsFake = seedFs(baseState({ step: "plan_review" }));
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: { enabled: false },
				vcs: { fingerprint: "M some/file.ts" },
			});
			return Effect.gen(function* () {
				const result = yield* dispatchWorkflow({ kind: "plan_review" }, ROOT);
				expect(result.ok).toBe(true);
				expect(savedState(fakeFs).reviewer_tree_fingerprint).toBe(
					"M some/file.ts",
				);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"an existing artifact is renamed to .bak.<millis> before dispatch (stale artifacts would be read as fresh by wait)",
		() => {
			const artifactPath = `${ROOT}/.apnea/artifacts/plan.md`;
			const fsFake = seedFs(baseState({ step: "planning" }), {
				[artifactPath]: "stale content",
			});
			const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } });
			return Effect.gen(function* () {
				const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT);
				expect(result.ok).toBe(true);
				expect(fakeFs.files.has(artifactPath)).toBe(false);
				const backups = [...fakeFs.files.keys()].filter((k) =>
					k.startsWith(`${artifactPath}.bak.`),
				);
				expect(backups.length).toBe(1);
				expect(fakeFs.files.get(backups[0]!)).toBe("stale content");
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"interactive path sets role_panes[role] and pending_pane_id from the fake launch",
		() => {
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs, herdr } = layerOf(fsFake, {
				herdr: {
					enabled: true,
					interactive: {
						pane_id: "pane-42",
						label: "apnea:planner:abc",
						reused: false,
						prompt_accepted: true,
						prompt_attempts: 1,
						last_status: "working",
					},
				},
			});
			return Effect.gen(function* () {
				const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.launch).toMatchObject({
						pane_id: "pane-42",
						mode: "interactive",
					});
				}
				expect(herdr.interactiveCalls.length).toBe(1);
				const saved = savedState(fakeFs);
				expect(saved.pending_pane_id).toBe("pane-42");
				expect(saved.role_panes.planner).toEqual({
					pane_id: "pane-42",
					label: "apnea:planner:abc",
				});
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"floating with herdr < 0.7.4 → HerdrError with the exact frozen message",
		() => {
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: { enabled: true, version: [0, 7, 3] },
				cfg: FLOATING_CFG,
			});
			return Effect.gen(function* () {
				const r = yield* Effect.result(
					dispatchWorkflow({ kind: "plan" }, ROOT),
				);
				const e = expectFailure(r, "HerdrError");
				expect(e.message).toBe(
					"floating panes need herdr >= 0.7.4 — run `herdr update`, or set pane_style=regular",
				);
				assertTaskRef(e.details, fakeFs);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect("floating with plugin missing → HerdrError", () => {
		const fsFake = seedFs(baseState({ step: "planning" }));
		const { layer, fakeFs } = layerOf(fsFake, {
			herdr: { enabled: true, version: [0, 7, 4], hasPlugin: false },
			cfg: FLOATING_CFG,
		});
		return Effect.gen(function* () {
			const r = yield* Effect.result(dispatchWorkflow({ kind: "plan" }, ROOT));
			const e = expectFailure(r, "HerdrError");
			expect(e.message).toContain("apnea herdr plugin not linked");
			assertTaskRef(e.details, fakeFs);

			const out = toToolResult(e);
			expect(out.ok).toBe(false);
			expect(out.data?.task).toBe(e.details?.task);
			expect(out.data?.artifact).toBe(".apnea/artifacts/plan.md");
		}).pipe(Effect.provide(layer));
	});

	itEffect(
		"floating while a prior oneshot is still in flight → GateRefused floating_in_flight",
		() => {
			const fsFake = seedFs(
				baseState({
					step: "planning",
					pending_floating_exit: ".apnea/tasks/plan-p1-r1-111.exit",
				}),
			);
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: { enabled: true, version: [0, 7, 4], hasPlugin: true },
				cfg: FLOATING_CFG,
			});
			return Effect.gen(function* () {
				const r = yield* Effect.result(
					dispatchWorkflow({ kind: "plan" }, ROOT),
				);
				const e = expectFailure(r, "GateRefused");
				expect(e.gate).toBe("floating_in_flight");
				expect(e.details?.pending_artifact).toBeNull();
				expect(e.details?.pending_floating_exit).toBe(
					".apnea/tasks/plan-p1-r1-111.exit",
				);
				assertTaskRef(e.details, fakeFs);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"floating happy path writes script, opens pane, sets pending_floating_exit, leaves role_panes untouched",
		() => {
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs, herdr } = layerOf(fsFake, {
				herdr: { enabled: true, version: [0, 7, 4], hasPlugin: true },
				cfg: FLOATING_CFG,
			});
			return Effect.gen(function* () {
				const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.launch).toMatchObject({
						pane_style_effective: "floating",
					});
				}
				expect(herdr.scripts.length).toBe(1);
				expect(herdr.openedPanes.length).toBe(1);
				const saved = savedState(fakeFs);
				expect(saved.pending_floating_exit).not.toBeNull();
				expect(saved.pending_pane_id).toBeNull();
				expect(saved.role_panes).toEqual({});
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"floating with no cmd_oneshot on the role profile → HerdrError carries the orphaned task",
		() => {
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: { enabled: true, version: [0, 7, 4], hasPlugin: true },
				cfg: FLOATING_NO_ONESHOT,
			});
			return Effect.gen(function* () {
				const r = yield* Effect.result(
					dispatchWorkflow({ kind: "plan" }, ROOT),
				);
				const e = expectFailure(r, "HerdrError");
				expect(e.message).toContain("cmd_oneshot");
				assertTaskRef(e.details, fakeFs);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"floating script write fails → HerdrError message preserved, task carried",
		() => {
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: {
					enabled: true,
					version: [0, 7, 4],
					hasPlugin: true,
					failWriteScript: new HerdrError({ message: "disk full" }),
				},
				cfg: FLOATING_CFG,
			});
			return Effect.gen(function* () {
				const r = yield* Effect.result(
					dispatchWorkflow({ kind: "plan" }, ROOT),
				);
				const e = expectFailure(r, "HerdrError");
				expect(e.message).toBe("disk full");
				assertTaskRef(e.details, fakeFs);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"floating open pane fails → HerdrError message preserved, task carried",
		() => {
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: {
					enabled: true,
					version: [0, 7, 4],
					hasPlugin: true,
					failOpenPane: new HerdrError({ message: "popup already open" }),
				},
				cfg: FLOATING_CFG,
			});
			return Effect.gen(function* () {
				const r = yield* Effect.result(
					dispatchWorkflow({ kind: "plan" }, ROOT),
				);
				const e = expectFailure(r, "HerdrError");
				expect(e.message).toBe("popup already open");
				assertTaskRef(e.details, fakeFs);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"interactive with no cmd_interactive on the role profile → ConfigError carries the orphaned task",
		() => {
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: { enabled: true },
				cfg: NO_INTERACTIVE_CFG,
			});
			return Effect.gen(function* () {
				const r = yield* Effect.result(
					dispatchWorkflow({ kind: "plan" }, ROOT),
				);
				const e = expectFailure(r, "ConfigError");
				expect(e.message).toContain("cmd_interactive");
				assertTaskRef(e.details, fakeFs);

				const out = toToolResult(e);
				expect(out.ok).toBe(false);
				expect(out.data?.task).toBe(e.details?.task);
				expect(out.data?.artifact).toBe(".apnea/artifacts/plan.md");
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"interactive runInteractivePrompt fails → HerdrError message preserved, task carried",
		() => {
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: {
					enabled: true,
					interactive: new HerdrError({ message: "pane split failed" }),
				},
			});
			return Effect.gen(function* () {
				const r = yield* Effect.result(
					dispatchWorkflow({ kind: "plan" }, ROOT),
				);
				const e = expectFailure(r, "HerdrError");
				expect(e.message).toBe("pane split failed");
				assertTaskRef(e.details, fakeFs);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"pre-write refusal carries no task/artifact and writes no task file",
		() => {
			// kind=code at step=planning fails before the task file is written.
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer, fakeFs } = layerOf(fsFake);
			return Effect.gen(function* () {
				const r = yield* Effect.result(
					dispatchWorkflow({ kind: "code" }, ROOT),
				);
				const e = expectFailure(r, "IllegalKind");
				const out = toToolResult(e);
				expect(out.data?.task).toBeUndefined();
				expect(out.data?.artifact).toBeUndefined();
				expect(
					[...fakeFs.files.keys()].some((k) => k.includes("/.apnea/tasks/")),
				).toBe(false);
			}).pipe(Effect.provide(layer));
		},
	);
});
