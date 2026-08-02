import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, test } from "bun:test";
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
		pending_started_at: null,
		pending_deadline_ms: null,
		pending_nudged_at: null,
		pending_final_grace: false,
		pending_extended: false,
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
		TestClock.layer(),
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

/** Runs dispatchWorkflow against a TestClock pinned to nowMs. */
async function runDispatch(
	params: Parameters<typeof dispatchWorkflow>[0],
	opts: {
		nowMs: number;
		cfg?: ApneaConfig;
		herdr?: Parameters<typeof fakeHerdrLayer>[0];
	},
): Promise<RunState> {
	const fsFake = seedFs(baseState({ step: "planning" }));
	const { layer, fakeFs } = layerOf(fsFake, {
		herdr: opts.herdr ?? {
			enabled: true,
			interactive: {
				pane_id: "pane-1",
				label: "apnea:planner:fake",
				reused: false,
				prompt_accepted: true,
				prompt_attempts: 1,
				last_status: "working",
			},
		},
		cfg: opts.cfg ?? {
			profiles: { pi: { cmd_interactive: ["pi"] } },
			roles: {
				planner: { profile: "pi" },
				reviewer: { profile: "pi" },
				coder: { profile: "pi" },
			},
			review_round_cap: 3,
			timeouts_ms: { planning: 1_500_000 },
			pane_style: "regular",
		},
	});
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* TestClock.setTime(opts.nowMs);
			yield* dispatchWorkflow(params, ROOT);
		}).pipe(Effect.provide(layer)),
	);
	return savedState(fakeFs);
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
		"no-herdr dispatch's legal_next omits dispatch_role — a dispatch is already outstanding",
		() => {
			// `nextAfter(state.step)` would return ["dispatch_role", "workflow_wait"]
			// at step=planning: it is step-derived and has no idea a dispatch is
			// in flight. An agent following legal_next literally would fire a
			// second dispatch that overwrites pending_artifact/pending_role and
			// orphans the first role's in-flight work.
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer } = layerOf(fsFake, { herdr: { enabled: false } });
			return Effect.gen(function* () {
				const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT);
				expect(result.ok).toBe(true);
				expect(result.legal_next).toEqual(["workflow_wait"]);
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
		"interactive dispatch's legal_next omits dispatch_role — a dispatch is already outstanding",
		() => {
			// Same reasoning as the no-herdr branch's legal_next test above: this
			// is the OTHER `ok(...)` return site in dispatch.ts, and both must
			// agree that `workflow_wait` is the only legal next call.
			const fsFake = seedFs(baseState({ step: "planning" }));
			const { layer } = layerOf(fsFake, {
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
				expect(result.legal_next).toEqual(["workflow_wait"]);
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

	test("dispatch stamps the clock so a later wait can resume the budget", async () => {
		// Without a persisted start and deadline, every fresh `apnea wait`
		// process would restart the timeout and a hung role would never fail.
		const now = 1_700_000_000_000;
		const state = await runDispatch({ kind: "plan" }, { nowMs: now });
		expect(state.pending_started_at).toBe(now);
		expect(state.pending_deadline_ms).toBe(now + 1_500_000);
		expect(state.pending_nudged_at).toBeNull();
		expect(state.pending_extended).toBe(false);
	});

	itEffect(
		"dispatch clears every recovery-ladder flag the previous role left behind",
		() => {
			// The ladder's flags are one-shot per dispatch. A flag that survives
			// into the next role silently disables that role's recovery: a stale
			// `pending_final_grace` skips its final nudge and 180s grace, a stale
			// `pending_nudged_at` skips its idle nudge, a stale `pending_extended`
			// denies its one-time extension. Nothing else in the suite covers
			// this — deleting a line from `resetRecoveryLadder` left the whole
			// suite green.
			//
			// BOTH save paths, because `dispatch` resets the ladder twice: once
			// on the manual-launch branch (no herdr) and once on the herdr
			// branch. The first version of this test ran only `enabled: false`,
			// so deleting the reset from the herdr path — the one every real run
			// takes — still passed.
			const seed = () =>
				seedFs(
					baseState({
						step: "planning",
						pending_nudged_at: 1_234,
						pending_final_grace: true,
						pending_extended: true,
					}),
				);
			const manual = layerOf(seed(), { herdr: { enabled: false } });
			const viaHerdr = layerOf(seed(), { herdr: { enabled: true } });
			const assertCleared = (fakeFs: ReturnType<typeof seedFs>) => {
				const saved = savedState(fakeFs);
				expect(saved.pending_nudged_at).toBeNull();
				expect(saved.pending_final_grace).toBe(false);
				expect(saved.pending_extended).toBe(false);
			};
			return Effect.gen(function* () {
				yield* Effect.gen(function* () {
					yield* dispatchWorkflow({ kind: "plan" }, ROOT);
					assertCleared(manual.fakeFs);
				}).pipe(Effect.provide(manual.layer));
				yield* Effect.gen(function* () {
					yield* dispatchWorkflow({ kind: "plan" }, ROOT);
					assertCleared(viaHerdr.fakeFs);
				}).pipe(Effect.provide(viaHerdr.layer));
			});
		},
	);

	test("no-Herdr dispatch also stamps the clock (manual launch still owes wait a deadline)", async () => {
		// This branch tells the operator to launch the role by hand and then
		// call workflow_wait. It offers the same workflow_wait contract as the
		// Herdr-driven branches, so it must not be the one path left with a
		// null deadline that silently falls back to the un-timed default.
		const now = 1_700_000_000_000;
		const state = await runDispatch(
			{ kind: "plan" },
			{ nowMs: now, herdr: { enabled: false } },
		);
		expect(state.pending_started_at).toBe(now);
		expect(state.pending_deadline_ms).toBe(now + 1_500_000);
		expect(state.pending_nudged_at).toBeNull();
		expect(state.pending_extended).toBe(false);
	});

	test("a slow interactive launch does not eat into the role's deadline (pending_started_at anchors after the launch, not before)", async () => {
		// `pending_started_at` is the anchor for both the role's own deadline
		// and wait's 12s liveness grace. Stamping it before
		// `runInteractivePrompt` charges the harness launch itself against the
		// role's working time and burns the grace before `apnea wait` polls
		// even once — one flaky `herdr pane get` then kills a live role.
		const now = 1_700_000_000_000;
		const interactiveDelayMs = 30_000; // well over the 12s liveness grace
		const state = await runDispatch(
			{ kind: "plan" },
			{
				nowMs: now,
				herdr: {
					enabled: true,
					interactive: {
						pane_id: "pane-1",
						label: "apnea:planner:fake",
						reused: false,
						prompt_accepted: true,
						prompt_attempts: 1,
						last_status: "working",
					},
					interactiveDelayMs,
				},
			},
		);
		expect(state.pending_started_at).toBe(now + interactiveDelayMs);
		// Budget is the role's configured timeout in full — the launch delay
		// must not be deducted from it.
		expect(state.pending_deadline_ms! - state.pending_started_at!).toBe(
			1_500_000,
		);
	});
});
