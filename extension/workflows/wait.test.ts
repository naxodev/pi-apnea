import { describe, expect } from "bun:test";
import { Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import type { DispatchKind } from "../domain/state-machine.ts";
import { statePath } from "../domain/paths.ts";
import type { ApneaConfig, RunState } from "../domain/types.ts";
import { toToolResult } from "../errors.ts";
import { fakeConfigLayer } from "../test/fake-config.ts";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { fakeHerdrLayer, type FakeHerdrOptions } from "../test/fake-herdr.ts";
import { fakeVcsLayer } from "../test/fake-vcs.ts";
import { itEffect } from "../test/it-effect.ts";
import { RunStoreLive } from "../services/run-store.ts";
import { dispatchWorkflow } from "./dispatch.ts";
import { waitWorkflow, type WaitParams } from "./wait.ts";

const ROOT = "/proj";

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
		herdr?: FakeHerdrOptions;
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

/**
 * Drives dispatch/wait as Effects sharing one fake filesystem + one
 * `TestClock` instance, so a fake `state.json` and clock persist across
 * separate `wait()` calls — simulating separate `apnea wait` processes
 * sharing one run.
 *
 * `dispatch`/`wait` return Effects rather than plain values: `waitWorkflow`
 * polls via `Effect.sleep`, and resuming a forked fiber past a `TestClock`
 * sleep goes through Effect's fiber scheduler, which needs a real async
 * boundary (confirmed empirically — `Effect.runSync` throws `AsyncFiberError`
 * for fork+adjust+join even though nothing here does real I/O). So a test
 * built on this harness stays one `Effect.gen`, `yield*`-ing `dispatch`/`wait`
 * in sequence and asserting between them, exactly like the other tests in
 * this file — just run once via `Effect.provide(t.layer)` + `itEffect`.
 */
function harness(
	opts: {
		timeouts_ms?: Record<string, number>;
		agentStatus?: string;
		/** Disable Herdr entirely — `lastStatus` stays "waiting" forever, so
		 * the recovery ladder (nudge/extend) never engages. Used by tests that
		 * only care about deadline arithmetic. */
		herdrEnabled?: boolean;
	} = {},
) {
	const state = baseState({ step: "planning" });
	const fsFake = seedFs(state);
	const cfg: ApneaConfig = {
		profiles: { pi: { cmd_interactive: ["pi"] } },
		roles: {
			planner: { profile: "pi" },
			reviewer: { profile: "pi" },
			coder: { profile: "pi" },
		},
		review_round_cap: 3,
		timeouts_ms: opts.timeouts_ms ?? { default: 900_000 },
		pane_style: "regular",
	};
	const { layer, fakeFs, herdr } = layerOf(fsFake, {
		cfg,
		herdr: {
			enabled: opts.herdrEnabled ?? true,
			pane: () => ({ ok: true, agent_status: opts.agentStatus ?? "working" }),
			interactive: {
				pane_id: "pane-1",
				label: "apnea:planner:fake",
				reused: false,
				prompt_accepted: true,
				prompt_attempts: 1,
				last_status: "working",
			},
		},
	});

	const dispatch = (kind: DispatchKind) => dispatchWorkflow({ kind }, ROOT);

	/**
	 * Forks `waitWorkflow`, advances the TestClock by exactly `budget_ms`
	 * (mirroring `budgetEnd = startedMs + budget` inside wait.ts itself), then
	 * joins — one "process" of `apnea wait`. Converts failures through the
	 * same `toToolResult` the real tool boundary uses, so `.ok`/.error/.data`
	 * match production shape.
	 *
	 * Defaults `poll_ms` to 1000: `TestClock.adjust` only wakes a sleeping
	 * fiber at its scheduled tick, so an adjust target that lands *between*
	 * two poll ticks (e.g. the default 2000ms poll with a 5000ms budget)
	 * leaves the fiber parked past the target and `Fiber.join` never
	 * resolves. Every `budget_ms` used by these tests is a multiple of 1000.
	 */
	const wait = (params: WaitParams) =>
		Effect.gen(function* () {
			const budget = params.budget_ms ?? 300_000;
			const fiber = yield* Effect.forkChild(
				waitWorkflow({ poll_ms: 1000, ...params }, ROOT),
			);
			yield* TestClock.adjust(budget);
			const r = yield* Effect.result(Fiber.join(fiber));
			if (Result.isFailure(r)) return toToolResult(r.failure);
			return r.success;
		});

	return {
		layer,
		dispatch,
		wait,
		state: (): RunState => savedState(fakeFs),
		herdr,
	};
}

describe("waitWorkflow (fake layers + TestClock)", () => {
	itEffect(
		"artifact already complete advances step, clears pending_*, and carries verdict/nits",
		() => {
			const state = baseState({
				step: "plan_review",
				pending_artifact: ".apnea/artifacts/plan-review/round-1.md",
				pending_role: "reviewer",
			});
			const fsFake = seedFs(state, {
				[`${ROOT}/.apnea/artifacts/plan-review/round-1.md`]:
					"---\nstatus: done\nverdict: APPROVED\nnits: minor\n---\nbody",
			});
			const { layer, fakeFs } = layerOf(fsFake);
			return Effect.gen(function* () {
				const result = yield* waitWorkflow({}, ROOT);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.verdict).toBe("APPROVED");
					expect(result.data?.nits).toBe("minor");
					expect(result.data?.step).toBe("phase_packaging");
				}
				const saved = savedState(fakeFs);
				expect(saved.step).toBe("phase_packaging");
				expect(saved.pending_artifact).toBeNull();
				expect(saved.pending_role).toBeNull();
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"code_review with status done but no verdict never advances — times out (a verdict-less review must never advance the machine)",
		() => {
			const state = baseState({
				step: "code_review",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/code-review.md",
				pending_role: "reviewer",
				pending_started_at: 0,
				pending_deadline_ms: 5_000,
			});
			const fsFake = seedFs(state, {
				[`${ROOT}/.apnea/artifacts/phase-01/round-1/code-review.md`]:
					"---\nstatus: done\n---\nbody",
			});
			const { layer, fakeFs } = layerOf(fsFake);
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 1_000 }, ROOT),
				);
				yield* TestClock.adjust(6_000);
				const result = yield* Effect.result(Fiber.join(fiber));
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result)) {
					expect(result.failure._tag).toBe("WaitTimeout");
					if (result.failure._tag === "WaitTimeout") {
						expect(result.failure.artifact).toBe(
							".apnea/artifacts/phase-01/round-1/code-review.md",
						);
					}
				}
				expect(savedState(fakeFs).step).toBe("code_review");
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"a stray non-review verdict on a code artifact still advances — validating it would wedge the run forever (state is not saved on failure, so every retry repeats)",
		() => {
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
			});
			const fsFake = seedFs(state, {
				[`${ROOT}/.apnea/artifacts/phase-01/round-1/coder-result.md`]:
					"---\nstatus: done\nverdict: PASS\n---\nbody",
			});
			const { layer, fakeFs } = layerOf(fsFake);
			return Effect.gen(function* () {
				const result = yield* waitWorkflow({}, ROOT);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.step).toBe("code_review");
					// asVerdict() still refuses to promote a bogus verdict to a real one
					expect(result.data?.verdict).toBeNull();
				}
				expect(savedState(fakeFs).step).toBe("code_review");
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"aborts via AbortSignal while parked in Effect.sleep, without ever advancing the clock — this is the interruption proof",
		() => {
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
			});
			const fsFake = seedFs(state);
			const { layer, fakeFs } = layerOf(fsFake);
			const controller = new AbortController();
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 5_000 }, ROOT, {
						signal: controller.signal,
					}),
				);
				controller.abort();
				// No TestClock.adjust anywhere in this test: a poll-loop flag check
				// would leave the fiber parked in a virtual sleep forever and this
				// join would hang. It resolves only because raceFirst interrupts it.
				const result = yield* Effect.result(Fiber.join(fiber));
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result)) {
					expect(result.failure._tag).toBe("WaitAborted");
				}
				expect(savedState(fakeFs).last_error).toBe("workflow_wait aborted");
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"floating exit code 129 with no artifact → HerdrError after the flush window, hint mentions Hangup",
		() => {
			const exitRel = ".apnea/tasks/plan-p1-r1-1.exit";
			const state = baseState({
				step: "planning",
				pending_artifact: ".apnea/artifacts/plan.md",
				pending_role: "planner",
				pending_floating_exit: exitRel,
			});
			const fsFake = seedFs(state, { [`${ROOT}/${exitRel}`]: "129\n" });
			const { layer, fakeFs } = layerOf(fsFake);
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 500 }, ROOT),
				);
				yield* TestClock.adjust(2_100); // past the 2000ms flush window
				const result = yield* Effect.result(Fiber.join(fiber));
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result) && result.failure._tag === "HerdrError") {
					expect(result.failure.details?.exit_code).toBe(129);
					expect(String(result.failure.details?.hint)).toMatch(/Hangup/i);
				}
				expect(savedState(fakeFs).pending_floating_exit).toBeNull();
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"floating exit while the artifact lands inside the flush window → success (the window exists precisely for this race)",
		() => {
			const exitRel = ".apnea/tasks/plan-p1-r1-1.exit";
			const artifactPath = `${ROOT}/.apnea/artifacts/plan.md`;
			const state = baseState({
				step: "planning",
				pending_artifact: ".apnea/artifacts/plan.md",
				pending_role: "planner",
				pending_floating_exit: exitRel,
			});
			const fsFake = seedFs(state, { [`${ROOT}/${exitRel}`]: "0\n" });
			const { layer, fakeFs } = layerOf(fsFake);
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 500 }, ROOT),
				);
				yield* TestClock.adjust(500);
				// Oneshot finishes writing just as the process exits — well inside
				// the 2000ms flush window.
				fsFake.files.set(artifactPath, "---\nstatus: done\n---\nbody");
				yield* TestClock.adjust(1_000);
				const result = yield* Fiber.join(fiber);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.step).toBe("plan_review");
				}
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"pane missing: still waiting before the 12s grace, HerdrError past it",
		() => {
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
				pending_pane_id: "pane-1",
			});
			const fsFake = seedFs(state);
			const paneUnknown = false;
			const { layer, fakeFs } = layerOf(fsFake, {
				herdr: { enabled: true, pane: () => ({ ok: paneUnknown }) },
			});
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 1_000 }, ROOT),
				);
				yield* TestClock.adjust(10_000); // before the 12s grace
				expect(fiber.pollUnsafe()).toBeUndefined();

				yield* TestClock.adjust(3_000); // past the grace
				const result = yield* Effect.result(Fiber.join(fiber));
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result) && result.failure._tag === "HerdrError") {
					expect(result.failure.message).toContain("pane gone");
				}
				expect(savedState(fakeFs).step).toBe("coding");
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"shell-only foreground for 4 consecutive polls past the grace → HerdrError with the foreground list",
		() => {
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
				pending_pane_id: "pane-1",
			});
			const fsFake = seedFs(state);
			const { layer } = layerOf(fsFake, {
				herdr: {
					enabled: true,
					pane: () => ({ ok: true, agent_status: "idle" }),
					foreground: ["zsh"],
				},
			});
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 1_000 }, ROOT),
				);
				yield* TestClock.adjust(20_000); // 12s grace + 4 shell-only polls
				const result = yield* Effect.result(Fiber.join(fiber));
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result) && result.failure._tag === "HerdrError") {
					expect(result.failure.message).toContain("harness exited");
					expect(result.failure.details?.foreground).toEqual(["zsh"]);
				}
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"idle for 90s triggers exactly one nudge; the artifact then arriving reports 'ready after nudge'",
		() => {
			const artifactPath = `${ROOT}/.apnea/artifacts/phase-01/round-1/coder-result.md`;
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
				pending_pane_id: "pane-1",
			});
			const fsFake = seedFs(state);
			const { layer, fakeFs, herdr } = layerOf(fsFake, {
				herdr: {
					enabled: true,
					pane: () => ({ ok: true, agent_status: "idle" }),
				},
			});
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 1_000 }, ROOT),
				);
				yield* TestClock.adjust(95_000); // past the 90s idle-stall threshold
				expect(herdr.paneRuns.length).toBe(1);
				expect(fiber.pollUnsafe()).toBeUndefined();

				fsFake.files.set(artifactPath, "---\nstatus: done\n---\nbody");
				yield* TestClock.adjust(1_000);
				const result = yield* Fiber.join(fiber);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.message).toContain("artifact ready after nudge");
				}
				expect(herdr.paneRuns.length).toBe(1); // exactly one nudge, never repeated
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"still working at the deadline extends the budget once by max(50%, 120000), then times out without a second extension",
		() => {
			const timeout = 100_000; // 50% = 50000 < 120000 floor, so extension = 120000
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
				pending_pane_id: "pane-1",
				pending_started_at: 0,
				pending_deadline_ms: timeout,
			});
			const fsFake = seedFs(state);
			const { layer } = layerOf(fsFake, {
				herdr: {
					enabled: true,
					pane: () => ({ ok: true, agent_status: "working" }),
				},
			});
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 1_000 }, ROOT),
				);
				yield* TestClock.adjust(110_000); // past the original deadline
				expect(fiber.pollUnsafe()).toBeUndefined();

				yield* TestClock.adjust(115_000); // cumulative 225000, past 100000+120000
				const result = yield* Effect.result(Fiber.join(fiber));
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result) && result.failure._tag === "WaitTimeout") {
					expect(result.failure.details?.extended_once).toBe(true);
				}
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"the one-time extension is not re-granted by a fresh wait call",
		() => {
			// This is the bug chunking introduces: `extendedOnce` used to be a
			// local, so every new `apnea wait` process would hand the role
			// another 50% extension and a hung role would never time out.
			// Every budget below is at the MIN_BUDGET_MS floor (120_000).
			const t = harness({
				timeouts_ms: { default: 150_000 },
				agentStatus: "working",
			});
			return Effect.gen(function* () {
				yield* t.dispatch("plan");

				// Budget smaller than the role timeout: ends in `pending`.
				const first = yield* t.wait({ budget_ms: 120_000 });
				expect(first.ok).toBe(true);
				expect(first.data?.pending).toBe(true);

				// Deadline (150_000) reached mid-call (clock 120_000 → 240_000).
				// Status is "working", so the ladder extends once: new deadline
				// = 150_000 + max(150_000*0.5, 120_000) = 270_000. This call's
				// own budgetEnd (240_000) still lands before that, so it reports
				// pending again — but the extension is now persisted.
				const second = yield* t.wait({ budget_ms: 120_000 });
				expect(second.ok).toBe(true);
				expect(second.data?.pending).toBe(true);
				expect(t.state().pending_extended).toBe(true);

				// A third call, budget 120_000 from clock 240_000 (→ 360_000),
				// spans the extended deadline (270_000). Must NOT extend again —
				// it must time out for real.
				const third = yield* t.wait({ budget_ms: 120_000 });
				expect(third.ok).toBe(false);
				if (!third.ok) {
					expect(third.error).toContain("timeout");
				}
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"budget spent with deadline remaining reports pending, not timeout",
		() => {
			// Exit code 3 vs 1 depends on this distinction: "call wait again"
			// must never be reported to an agent as "this run is stuck".
			const t = harness({ timeouts_ms: { default: 600_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({ budget_ms: 120_000 }); // MIN_BUDGET_MS floor
				expect(r.ok).toBe(true);
				expect(r.data?.pending).toBe(true);
				expect(r.legal_next).toEqual(["workflow_wait"]);
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"a budget under the floor is refused, naming the floor",
		() => {
			// MIN_BUDGET_MS exists because a smaller budget can't fit the 90s
			// idle-nudge rung inside one call — see wait.ts's module doc.
			const t = harness({ timeouts_ms: { default: 600_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({ budget_ms: 60_000 });
				expect(r.ok).toBe(false);
				if (!r.ok) {
					expect(r.error).toContain("120000");
				}
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"the deadline is measured from dispatch, not from the wait call",
		() => {
			// Regression target: an implementation that recomputes the deadline
			// from its own `Clock.currentTimeMillis` read at wait-call start
			// (ignoring `state.pending_deadline_ms`) would time out ~30s after
			// *this* call started (~t=55_000), not ~30s after dispatch
			// (~t=30_000). Herdr disabled so `lastStatus` stays "waiting" and
			// the recovery ladder can't extend the deadline out from under us.
			const t = harness({
				timeouts_ms: { default: 30_000 },
				herdrEnabled: false,
			});
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				yield* TestClock.adjust(25_000); // 25s pass before the agent calls wait

				const fiber = yield* Effect.forkChild(
					waitWorkflow({ budget_ms: 120_000, poll_ms: 2_000 }, ROOT),
				);

				yield* TestClock.adjust(4_000); // cumulative 29s: still short of t=30s
				expect(fiber.pollUnsafe()).toBeUndefined();

				yield* TestClock.adjust(2_000); // cumulative 31s: past t=30s
				// A dispatch-anchored deadline must have resolved by now; a
				// wait-call-anchored deadline (bug) would still be parked until
				// t=55s, so `pollUnsafe` would stay undefined here — the
				// `toBeDefined` below is what fails under that regression.
				expect(fiber.pollUnsafe()).toBeDefined();

				const result = yield* Effect.result(Fiber.join(fiber));
				expect(Result.isFailure(result)).toBe(true);
				if (Result.isFailure(result)) {
					expect(result.failure._tag).toBe("WaitTimeout");
				}
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"a nudge is not re-fired merely because the process is new",
		() => {
			// `nudged` used to be a local. Re-nudging every invocation would spam
			// a working role's pane with duplicate prompts.
			const t = harness({
				timeouts_ms: { default: 600_000 },
				agentStatus: "idle",
			});
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				yield* t.wait({ budget_ms: 120_000 });
				expect(t.state().pending_nudged_at).not.toBeNull();
				const nudgesAfterFirst = t.herdr.paneRuns.length;
				yield* t.wait({ budget_ms: 120_000 });
				expect(t.herdr.paneRuns.length).toBe(nudgesAfterFirst);
			}).pipe(Effect.provide(t.layer));
		},
	);
});
