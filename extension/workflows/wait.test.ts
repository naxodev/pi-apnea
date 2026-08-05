import { describe, expect } from "bun:test";
import { Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import type { DispatchKind } from "../domain/state-machine.ts";
import { statePath } from "../domain/paths.ts";
import type { ApneaConfig, RunState } from "../domain/types.ts";
import { HerdrError, toToolResult } from "../errors.ts";
import { expectFailure } from "../test/expect-failure.ts";
import { fakeConfigLayer } from "../test/fake-config.ts";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { fakeHerdrLayer, type FakeHerdrOptions } from "../test/fake-herdr.ts";
import { fakeVcsLayer } from "../test/fake-vcs.ts";
import { itEffect } from "../test/it-effect.ts";
import { RunStoreLive } from "../services/run-store.ts";
import { Herdr } from "../services/herdr.ts";
import { briefFiles } from "../test/briefs.ts";
import { dispatchWorkflow } from "./dispatch.ts";
import {
	DEFAULT_BUDGET_MS,
	MAX_AUTO_POLL_MS,
	defaultBudgetFor,
	minBudgetFor,
	waitWorkflow,
	type WaitParams,
} from "./wait.ts";

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
		...briefFiles("/pkg"),
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
/**
 * The one config shape these tests run against; only `timeouts_ms` ever varies.
 *
 * Shared so a test that overrides the timeouts cannot also drift its roles or
 * profiles away from every other test in the file — a deadline test quietly
 * exercising a different role binding proves something nobody asked about.
 */
function makeConfig(timeouts_ms?: Record<string, number>): ApneaConfig {
	return {
		profiles: { pi: { cmd_interactive: ["pi"] } },
		roles: {
			planner: { profile: "pi" },
			reviewer: { profile: "pi" },
			coder: { profile: "pi" },
		},
		review_round_cap: 3,
		timeouts_ms: timeouts_ms ?? { default: 900_000 },
		pane_style: "regular",
	};
}

function harness(
	opts: {
		timeouts_ms?: Record<string, number>;
		/** A function lets a test flip the role's status between wait calls. */
		agentStatus?: string | (() => string);
		/** Disable Herdr entirely — `lastStatus` stays "waiting" forever, so
		 * the recovery ladder (nudge/extend) never engages. Used by tests that
		 * only care about deadline arithmetic. */
		herdrEnabled?: boolean;
		/** Make every `herdr pane run` fail, modelling a pane that accepts no
		 * input (agent CLI rejects it, herdr version skew). */
		failPaneRun?: boolean;
		/** Pane foreground process names — `["zsh"]` models a crashed harness.
		 * A function lets a test flip the foreground between polls, the same
		 * way `agentStatus` already can. */
		foreground?: string[] | (() => string[]);
	} = {},
) {
	const state = baseState({ step: "planning" });
	const fsFake = seedFs(state);
	const cfg = makeConfig(opts.timeouts_ms);
	const { layer, fakeFs, herdr } = layerOf(fsFake, {
		cfg,
		herdr: {
			enabled: opts.herdrEnabled ?? true,
			...(opts.foreground ? { foreground: opts.foreground } : {}),
			...(opts.failPaneRun
				? { failPaneRun: new HerdrError({ message: "pane run failed" }) }
				: {}),
			pane: () => ({
				ok: true,
				agent_status:
					typeof opts.agentStatus === "function"
						? opts.agentStatus()
						: (opts.agentStatus ?? "working"),
			}),
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
	 *
	 * The fallback calls the workflow's own `defaultBudgetFor` rather than
	 * restating it. This harness used to keep its own copy of that expression,
	 * which fails in the worst way: a change to the rule advances the shared
	 * clock short of where the call actually returns, `Fiber.join` never
	 * resolves, and the test dies on a bun-test timeout with nothing pointing
	 * at the formula.
	 */
	const wait = (params: WaitParams) =>
		Effect.gen(function* () {
			const pollForBudget = params.poll_ms ?? 1000;
			const budget = params.budget_ms ?? defaultBudgetFor(pollForBudget);
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
				const e = expectFailure(result, "WaitTimeout");
				expect(e.artifact).toBe(
					".apnea/artifacts/phase-01/round-1/code-review.md",
				);
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
				expectFailure(result, "WaitAborted");
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
				const e = expectFailure(result, "HerdrError");
				expect(e.details?.exit_code).toBe(129);
				expect(String(e.details?.hint)).toMatch(/Hangup/i);
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
				const e = expectFailure(result, "HerdrError");
				expect(e.message).toContain("pane gone");
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
				const e = expectFailure(result, "HerdrError");
				expect(e.message).toContain("harness exited");
				expect(e.details?.foreground).toEqual(["zsh"]);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"an already-nudged role still gets its final grace — the two rungs are independent",
		() => {
			// The idle nudge and the final grace used to share the `!nudged`
			// guard, so any earlier nudge silently spent the grace. Lowering
			// IDLE_NUDGE_AFTER_MS to 60s made that reachable: a role idle 60-89s
			// got nudged, then died at its deadline 180s sooner than before.
			// `pending_final_grace` is what makes the rung one-shot now.
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
				pending_pane_id: "pane-1",
				pending_started_at: 0,
				pending_deadline_ms: 30_000,
				// Already nudged earlier in the run.
				pending_nudged_at: 5_000,
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
					waitWorkflow({ poll_ms: 1_000, budget_ms: 100_000 }, ROOT),
				);
				yield* TestClock.adjust(40_000); // past the 30s deadline
				// The grace must have been granted despite the earlier nudge.
				expect(savedState(fakeFs).pending_final_grace).toBe(true);
				expect(
					savedState(fakeFs).pending_deadline_ms,
				).toBeGreaterThanOrEqual(180_000);
				// And a prompt must actually have been SENT. `tryNudge`
				// self-suppresses once `nudged` is set, so decoupling the rungs
				// bought this role 180s of silence and nothing else: same
				// escalation, three minutes later. The grace is time for a prompt
				// to land, so the deadline rung forces the send.
				expect(herdr.paneRuns.length).toBe(1);
				yield* TestClock.adjust(300_000);
				yield* Effect.result(Fiber.join(fiber));
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"B4b — the dead-harness rung still completes at a large poll, exactly at the floor",
		() => {
			// B4 runs at poll=1000, where the floor's poll term is irrelevant and
			// there is a 74s margin — it passes for almost any constants. This is
			// the case the floor formula actually promises: at
			// budget == minBudgetFor(poll) with the poll term dominating, four
			// consecutive polls must still fit: grace ends at 12s, so the polls
			// at 30/60/90/120s are the four that count and the rung fires at
			// 120s, inside the 132s floor. Shrink the floor or raise
			// DEAD_POLLS_NEEDED and this stops holding.
			const t = harness({
				timeouts_ms: { default: 900_000 },
				agentStatus: "working",
				foreground: ["zsh"],
			});
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({ poll_ms: 30_000, budget_ms: 132_000 });
				expect(r.ok).toBe(false);
				if (!r.ok) {
					expect(r.error).toContain("harness exited without writing");
				}
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"a call returns by its budget even when the poll interval would overshoot",
		() => {
			// The sleep used to be a flat `poll`, so the last iteration could
			// sleep straight past budgetEnd — at poll=30000/budget=132000 the
			// call returned at 150s, well past the 120s host shell timeout the
			// 90s default exists to stay under, and the caller saw a killed
			// command instead of exit 3. Asserted via pollUnsafe so an overrun
			// fails cleanly instead of parking the fiber until the test times out.
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
				pending_pane_id: "pane-1",
				pending_started_at: 0,
				pending_deadline_ms: 900_000,
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
					waitWorkflow({ poll_ms: 30_000, budget_ms: 132_000 }, ROOT),
				);
				yield* TestClock.adjust(132_000);
				expect(fiber.pollUnsafe()).not.toBeUndefined();
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"a role idle for less than the nudge threshold is left alone",
		() => {
			// Pins IDLE_NUDGE_AFTER_MS from BELOW. The suite pinned it only from
			// above, so lowering it to 45s to "nudge sooner" shipped green — and
			// every role that pauses for a slow build, a long tool call or a
			// permission prompt would get an unsolicited "You appear idle" prompt
			// injected into its pane mid-turn, corrupting its context and burning
			// the one-shot nudge on a role that was working fine.
			// The first version of this test asked for `budget_ms: 55_000`, which
			// is under the 72000 floor — so the call was REFUSED and never polled
			// at all. `paneRuns.length` was 0 because nothing ran. It survived a
			// mutation check only because a second assertion compared the constant
			// to itself; the behavioural half could not fail. Both mistakes are
			// fixed here: the call is legal, and the constant assertion is gone,
			// so the only way to pass is to actually not nudge.
			//
			// The role works for the first 45 polls, then reads idle for the rest
			// of a 90s call — 45s of unbroken idleness, short of the 60s
			// threshold. Lower the threshold under 45s and the nudge fires.
			let polls = 0;
			const t = harness({
				timeouts_ms: { default: 900_000 },
				agentStatus: () => (polls++ < 45 ? "working" : "idle"),
			});
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				yield* t.wait({ poll_ms: 1_000, budget_ms: 90_000 });
				expect(t.herdr.paneRuns.length).toBe(0);
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"B4 — the dead-harness rung fires inside one default-budget call",
		() => {
			// Mirrors B1 for the other duration-based rung: GRACE_MS (12s) plus
			// DEAD_POLLS_NEEDED (4) consecutive shell-only polls at the harness's
			// 1000ms poll interval is 16s, well inside DEFAULT_BUDGET_MS (90s).
			const t = harness({
				timeouts_ms: { default: 900_000 },
				agentStatus: "working",
				foreground: ["zsh"],
			});
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({}); // default budget, harness's 1000ms poll
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.error).toContain("harness exited without writing");
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"B5 — a healthy poll resets the shell-only counter, so an alternating foreground never raises the harness error",
		() => {
			// Alternates zsh/node every poll so `shellOnlyPolls` is reset by the
			// `else` branch before it can reach DEAD_POLLS_NEEDED consecutively —
			// it should climb at most to 1, never accumulate.
			let poll = 0;
			const t = harness({
				timeouts_ms: { default: 900_000 },
				agentStatus: "working",
				foreground: () => (poll++ % 2 === 0 ? ["zsh"] : ["node"]),
			});
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({}); // default budget, harness's 1000ms poll
				expect(r.ok).toBe(true);
				expect(r.data?.pending).toBe(true);
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"idle for 60s triggers exactly one nudge; the artifact then arriving reports 'ready after nudge'",
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
					// Explicit budget: this test is about the 60s idle rung
					// (IDLE_NUDGE_AFTER_MS) plus the round-trip to "ready after
					// nudge", so it must not also depend on whatever
					// DEFAULT_BUDGET_MS happens to be. See B1 below for the
					// default-budget case.
					waitWorkflow({ poll_ms: 1_000, budget_ms: 300_000 }, ROOT),
				);
				yield* TestClock.adjust(65_000); // past the 60s idle-stall threshold
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
		"B1 — the idle nudge fires inside one default-budget call, exactly once",
		() => {
			// The rung the whole redesign exists for: GRACE_MS (12s) + one
			// IDLE_NUDGE_AFTER_MS (60s) = 72s must fit inside DEFAULT_BUDGET_MS
			// (90s), so a role idle for the whole call gets nudged once without
			// needing a second `apnea wait` process to observe it.
			const t = harness({
				timeouts_ms: { default: 900_000 },
				agentStatus: "idle",
			});
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({}); // default budget, harness's 1000ms poll
				expect(r.ok).toBe(true);
				expect(t.herdr.paneRuns.length).toBe(1);
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"a failed nudge still shows the send was attempted, and leaves the rung armed instead of burning it (a dead pane must not permanently disable recovery)",
		() => {
			// Before the fix, `state.pending_nudged_at` was persisted BEFORE
			// `paneRun` ran, so a failing pane still recorded `nudged: true`
			// forever — both nudge rungs (`nudged` is seeded from
			// `pending_nudged_at` on every later `wait` call, and the final-nudge
			// rung is guarded by `!nudged`) were then permanently disabled, and
			// the run died at the deadline reporting `nudged: true` even though
			// no prompt was ever delivered.
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
				pending_pane_id: "pane-1",
				pending_started_at: 0,
				pending_deadline_ms: 200_000,
			});
			const fsFake = seedFs(state);
			const { layer, fakeFs, herdr } = layerOf(fsFake, {
				herdr: {
					enabled: true,
					pane: () => ({ ok: true, agent_status: "idle" }),
					failPaneRun: new HerdrError({ message: "pane run failed" }),
				},
			});
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					// budget_ms well past both the deadline and the final-nudge grace
					// so the call keeps running instead of returning an intermediate
					// "still waiting" `pending: true` when the CLI's chunking budget
					// is hit first.
					waitWorkflow({ poll_ms: 1_000, budget_ms: 500_000 }, ROOT),
				);
				// Past the 60s idle-stall rung, the 200_000ms deadline, and the
				// 180_000ms final-nudge grace the timeout-idle rung grants itself —
				// far enough that the run has genuinely timed out.
				yield* TestClock.adjust(400_000);
				const result = yield* Effect.result(Fiber.join(fiber));
				expectFailure(result, "WaitTimeout");
				// The send was attempted (at least the idle-stall rung, likely also
				// the timeout-idle rung) — this is what "attempted but failed" means,
				// as opposed to "never attempted".
				expect(herdr.paneRuns.length).toBeGreaterThan(0);
				// Still armed: a fresh `wait` call must be able to try the rung
				// again rather than seeing a nudge that was never delivered.
				expect(savedState(fakeFs).pending_nudged_at).toBeNull();
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
				// The extension is sized from the role's CONFIGURED timeout, so the
				// config has to agree with the seeded deadline. Deriving it from
				// `pending_deadline_ms` instead let a granted grace inflate the next
				// call's extension.
				cfg: makeConfig({ coding: timeout, default: timeout }),
				herdr: {
					enabled: true,
					pane: () => ({ ok: true, agent_status: "working" }),
				},
			});
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					// Budget well past the extended deadline: this test is about the
					// deadline rungs, not about the per-call chunking budget.
					waitWorkflow({ poll_ms: 1_000, budget_ms: 500_000 }, ROOT),
				);
				yield* TestClock.adjust(110_000); // past the original deadline
				expect(fiber.pollUnsafe()).toBeUndefined();

				yield* TestClock.adjust(115_000); // cumulative 225000, past 100000+120000
				const result = yield* Effect.result(Fiber.join(fiber));
				const e = expectFailure(result, "WaitTimeout");
				expect(e.details?.extended_once).toBe(true);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"the one-time extension is not re-granted by a fresh wait call",
		() => {
			// This is the bug chunking introduces: `extendedOnce` used to be a
			// local, so every new `apnea wait` process would hand the role
			// another 50% extension and a hung role would never time out.
			// The 120000ms budgets below are load-bearing for the deadline arithmetic
			// (150000 timeout, 120000 extension) — they are not floor values.
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
				const r = yield* t.wait({ budget_ms: 120_000 }); // spans the extension window
				expect(r.ok).toBe(true);
				expect(r.data?.pending).toBe(true);
				expect(r.legal_next).toEqual(["workflow_wait"]);
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"a role behind an unpromptable pane still times out — the final-nudge grace is granted once per run, not once per call",
		() => {
			// The regression a smaller default budget exposes. The 180s grace was
			// gated on a per-call local plus `!nudged`; once a failed `paneRun`
			// stopped persisting `pending_nudged_at`, neither guard survived the
			// call, so every fresh `apnea wait` re-granted 180s and the deadline
			// walked forward forever. The orchestrator would receive exit 3
			// "call again" indefinitely and never escalate to a human.
			//
			// `pending_final_grace` is a fact (not a duration), so it is still
			// persisted under the new design and this invariant is unaffected by
			// the per-call idle/dead-poll rewrite — only the numbers below moved,
			// to clear the new 72_000ms floor at the harness's 1000ms poll.
			const t = harness({
				timeouts_ms: { default: 50_000 },
				agentStatus: "idle",
				failPaneRun: true,
			});
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const grantedDeadline = 50_000 + 180_000; // the one-time final-nudge grace
				let lastDeadline = 0;
				for (let i = 0; i < 5; i++) {
					// 90_000: above the 72_000 floor at the harness's 1000ms poll.
					const r = yield* t.wait({ budget_ms: 90_000 });
					if (!r.ok) {
						expect(r.error).toContain("timeout");
						return;
					}
					const deadline = t.state().pending_deadline_ms ?? 0;
					// Each iteration must not buy another grace window.
					expect(deadline).toBeLessThanOrEqual(
						Math.max(lastDeadline, grantedDeadline),
					);
					lastDeadline = deadline;
				}
				throw new Error(
					"never timed out: the grace is still being re-granted per call",
				);
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"B2 — the budget floor scales with poll_ms and is refused below it",
		() => {
			// Literal 132000, NOT `minBudgetFor(30_000)`: deriving the expectation
			// from the function under test would pass for any formula at all,
			// including one that no longer scales with poll_ms. 132_000 =
			// GRACE_MS(12_000) + DEAD_POLLS_NEEDED(4) * 30_000 — the
			// dead-harness-poll term dominates IDLE_NUDGE_AFTER_MS(60_000) once
			// poll_ms is this large.
			const t = harness({ timeouts_ms: { default: 600_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({ poll_ms: 30_000, budget_ms: 131_999 });
				expect(r.ok).toBe(false);
				if (!r.ok) {
					expect(r.error).toContain("must be >= 132000 at poll_ms=30000");
				}
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"B2b — the floor holds the idle rung's length when poll is small",
		() => {
			// B2 uses poll=30000, where 4*poll dominates and the
			// `max(IDLE_NUDGE_AFTER_MS, ...)` term is dead weight. Dropping that
			// term entirely leaves B2 green, and then `--poll=2000 --budget=25000`
			// is accepted while the 60s idle nudge can never complete inside it —
			// a stalled coder burns its full 45-minute timeout un-nudged. Literal
			// 72000 = GRACE_MS(12_000) + IDLE_NUDGE_AFTER_MS(60_000).
			const t = harness({ timeouts_ms: { default: 600_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({ poll_ms: 2_000, budget_ms: 71_999 });
				expect(r.ok).toBe(false);
				if (!r.ok) {
					expect(r.error).toContain("must be >= 72000 at poll_ms=2000");
				}
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"B2c — an omitted budget is raised to the floor rather than refused",
		() => {
			// The floor passes DEFAULT_BUDGET_MS at any poll above 19500, so
			// leaving the default alone made `apnea wait --poll=20000` — legal on
			// main — exit 1 instead of polling. The call gets longer; it does not
			// get rejected.
			const t = harness({ timeouts_ms: { default: 600_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({ poll_ms: 20_000 });
				expect(r.ok).toBe(true);
				if (r.ok) expect(r.data?.pending).toBe(true);
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"legacy state with no deadline is stamped from the role's own timeout, not the default",
		() => {
			// State written before `pending_deadline_ms` existed gets its deadline
			// stamped on first `wait`. That stamp used `timeouts_ms.default` while
			// everything downstream — the one-time extension and the timeoutMs the
			// human is shown — used the per-kind key. A coder configured for 45
			// minutes was killed at the 15-minute default and then told it had been
			// given 45.
			//
			// Literals, not `timeoutMsForKind(...)`: computing the expectation from
			// the same helper the fix calls would pass even if the stamp went back
			// to reading `default`.
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
				pending_pane_id: "pane-1",
				pending_started_at: 0,
				pending_deadline_ms: null,
			});
			const fsFake = seedFs(state);
			const { layer, fakeFs } = layerOf(fsFake, {
				cfg: makeConfig({ coding: 2_700_000, default: 900_000 }),
				herdr: { enabled: false },
			});
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 1_000, budget_ms: 90_000 }, ROOT),
				);
				yield* TestClock.adjust(90_000);
				yield* Fiber.join(fiber);
				expect(savedState(fakeFs).pending_deadline_ms).toBe(2_700_000);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"B2d — a poll whose floor outgrows the host shell is refused, not silently raised past it",
		() => {
			// B2c raises an omitted budget to the floor. Past poll_ms=27000 that
			// raise lands above the ~120s an agent shell allows, so the call is
			// killed before it can return exit 3 — the caller gets no resume
			// instruction at all, which is worse than the refusal B2c removed.
			//
			// Literal 28000, one step over the boundary, and literal 26999 in the
			// message: deriving either from MAX_AUTO_POLL_MS would pass for any
			// ceiling, including one above the shell timeout it exists to respect.
			// 26999 rather than 27000 because the budget must land STRICTLY under
			// the shell timeout — see B2d2.
			const t = harness({ timeouts_ms: { default: 600_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({ poll_ms: 28_000 });
				expect(r.ok).toBe(false);
				if (!r.ok) {
					expect(r.error).toContain("Lower --poll to 26999");
				}
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"B2d2 — the poll ceiling is exclusive: the largest accepted poll stays strictly under the shell timeout",
		() => {
			// The first ceiling was `floor((120000 - 12000) / 4)` = 27000, and the
			// gate was `poll > that`, so poll_ms=27000 was ACCEPTED and picked a
			// budget of exactly 120000 — equal to the shell timeout it exists to
			// stay under. A call that runs exactly as long as the shell allows is
			// killed at the instant it would have returned exit 3, which is the
			// whole failure the ceiling prevents.
			//
			// Literal 120_000, not HOST_SHELL_TIMEOUT_MS: this asserts the budget
			// lands under a real external limit, and deriving the bound from the
			// same constant the code uses would hold even if both moved together
			// past what a shell actually permits.
			return Effect.sync(() => {
				expect(defaultBudgetFor(MAX_AUTO_POLL_MS)).toBeLessThan(120_000);
				expect(defaultBudgetFor(MAX_AUTO_POLL_MS + 1)).toBeGreaterThanOrEqual(
					120_000,
				);
			});
		},
	);

	itEffect(
		"B2e — an explicit budget is still honoured above that poll ceiling",
		() => {
			// The ceiling refuses a budget we would have PICKED, not one the
			// caller picked. A blanket poll cap would break the orchestrator that
			// knows its own shell allows a longer call, and the floor already
			// forces such a caller to state the long budget out loud.
			const t = harness({ timeouts_ms: { default: 600_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({ poll_ms: 28_000, budget_ms: 124_000 });
				expect(r.ok).toBe(true);
				if (r.ok) expect(r.data?.pending).toBe(true);
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"B3 — the default budget clears the floor at the default poll",
		() => {
			// A real invariant with no behavioural expression of its own: if this
			// ever goes false, every default-budget call in the suite starts
			// refusing itself. 120_000 is external to this system — agent shell
			// tools commonly default to a 120s timeout, and DEFAULT_BUDGET_MS
			// must stay under it so a call is killed before it can return the
			// exit-3 "call me again" result.
			return Effect.sync(() => {
				expect(DEFAULT_BUDGET_MS).toBeGreaterThanOrEqual(minBudgetFor(2_000));
				expect(DEFAULT_BUDGET_MS).toBeLessThan(120_000);
			});
		},
	);

	itEffect(
		"a poll_ms below the minimum is refused — a sign check alone still allowed a busy-spin",
		() => {
			// `poll_ms: 0` survives `??` (it is not nullish) and `Effect.sleep(0)`
			// does not yield, so the loop would hammer fs.exists + herdr pane get
			// + herdr foreground-names with no delay. But rejecting only <= 0 left
			// `--poll=1` doing the same thing 1ms at a time: ~144k subprocesses
			// over one floor-length call. The literal 250 is the contract; change
			// the constant and this test should fail.
			const t = harness({ timeouts_ms: { default: 600_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				for (const bad of [0, -1_000, 1, 249]) {
					const r = yield* t.wait({ poll_ms: bad, budget_ms: 90_000 });
					expect(r.ok).toBe(false);
					if (!r.ok) expect(r.error).toContain("250");
				}
			}).pipe(Effect.provide(t.layer));
		},
	);

	itEffect(
		"the default budget returns 'still waiting' inside a 120s host shell — literal bounds, so raising the default fails this test",
		() => {
			// The number this whole change exists to set. Nothing else in the
			// suite pins it: every other test passes an explicit budget, so
			// DEFAULT_BUDGET_MS could be set to 300s or deleted without a single
			// failure. The bound that matters is external — agent shell tools
			// commonly default to 120s, and a call that outlives that is killed
			// before it can return the exit 3 that tells the caller to try again.
			//
			// `budget_ms` is omitted entirely — the previous version of this
			// test passed `budget_ms: 119_000` explicitly, which never touches
			// `DEFAULT_BUDGET_MS` at all; the harness's own `wait` helper falls
			// back to the constant only when the field is absent, mirroring
			// `params.budget_ms ?? DEFAULT_BUDGET_MS` inside wait.ts itself.
			const t = harness({ timeouts_ms: { default: 900_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const r = yield* t.wait({});
				expect(r.ok).toBe(true);
				if (r.ok) expect(r.data?.pending).toBe(true);
				expect(DEFAULT_BUDGET_MS).toBeLessThan(120_000);
				expect(DEFAULT_BUDGET_MS).toBeGreaterThanOrEqual(30_000);
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

	itEffect(
		"an abort during the final nudge does not burn the grace — the flag and the extended deadline land in one save, never one without the other",
		() => {
			// Driving a real abort (not just inspecting persisted state at rest):
			// a custom Herdr layer whose `paneRun` never resolves lets the abort
			// land exactly inside `tryNudge`, after the pre-nudge state mutation
			// but before any post-nudge one — the same window the original bug
			// lived in. `fakeHerdrLayer` has no way to make `paneRun` hang, so
			// this builds the layer by hand instead of adding a knob to the
			// shared test helper.
			//
			// Before the fix: the flag write and the deadline extension were two
			// separate `store.save` calls straddling `tryNudge`. An abort that
			// landed between them left `pending_final_grace: true` on disk paired
			// with the OLD (already-expired) deadline — the role lost its 180s
			// grace window silently. The fix collapses both writes into one save
			// that happens entirely before `tryNudge` runs, so an abort can never
			// observe one field without the other.
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
				pending_pane_id: "pane-1",
				pending_started_at: 0,
				pending_deadline_ms: 50_000,
			});
			const fsFake = seedFs(state);
			const cfg = fakeConfigLayer({});
			const vcs = fakeVcsLayer({});
			const hangingHerdr = Layer.succeed(
				Herdr,
				Herdr.of({
					enabled: Effect.succeed(true),
					version: Effect.succeed(null),
					hasApneaPlugin: Effect.succeed(true),
					paneGet: () => Effect.succeed({ ok: true, agent_status: "idle" }),
					// Never resolves: models `tryNudge` blocked on its herdr
					// subprocess, so the abort below lands mid-call rather than
					// before or after it.
					paneRun: () => Effect.never,
					paneForegroundNames: () => Effect.succeed([]),
					runInteractivePrompt: () =>
						Effect.succeed({
							pane_id: "pane-1",
							label: "apnea:coder:fake",
							reused: false,
							prompt_accepted: true,
							prompt_attempts: 1,
							last_status: "working",
						}),
					writeFloatingTaskScript: () => Effect.void,
					openFloatingPane: () => Effect.void,
					linkPlugin: () => Effect.succeed({ ok: true, raw: "" }),
				}),
			);
			const layer = Layer.mergeAll(
				Layer.provideMerge(RunStoreLive, fsFake.layer),
				cfg,
				vcs.layer,
				hangingHerdr,
				TestClock.layer(),
			);
			const controller = new AbortController();
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 1_000, budget_ms: 200_000 }, ROOT, {
						signal: controller.signal,
					}),
				);
				yield* TestClock.adjust(50_000); // reach the 50_000ms deadline, idle
				// The fiber must now be parked inside `tryNudge`'s `paneRun`,
				// which never resolves — this is the window the bug lived in.
				expect(fiber.pollUnsafe()).toBeUndefined();

				controller.abort();
				const result = yield* Effect.result(Fiber.join(fiber));
				expectFailure(result, "WaitAborted");

				const saved = savedState(fsFake);
				expect(saved.pending_final_grace).toBe(true);
				// The extended deadline must be on disk together with the grace
				// flag — never the OLD (already-passed) deadline paired with
				// `pending_final_grace: true`, which is what silently cost the
				// role its 180s grace window under the bug.
				expect(saved.pending_deadline_ms).toBe(50_000 + 180_000);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"a large poll_ms does not let a call outlive its budget — the sleep is clamped to what's left",
		() => {
			// A legal `--poll=60000` call used to poll at t=0, t=60000, then sleep
			// a full 60s again and overrun its budget by nearly a whole poll
			// interval — past the host shell timeout the budget exists to fit
			// inside. The caller saw a killed command instead of the exit-3
			// resume instruction. The fix clamps the sleep to what's left.
			//
			// poll_ms=20_000, budget_ms=95_000: the smallest pair that both
			// demonstrates a clamp (95_000 is not a multiple of 20_000, so the
			// last sleep must be shortened) and clears minBudgetFor(20_000) =
			// GRACE_MS(12_000) + DEAD_POLLS_NEEDED(4)*20_000 = 92_000. The old
			// 60_000/90_000 pair used before the floor scaled with poll_ms is
			// now illegal on its own terms (90_000 < minBudgetFor(60_000) =
			// 252_000) — it would be refused before ever reaching the loop.
			const state = baseState({
				step: "coding",
				pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
				pending_role: "coder",
			});
			const fsFake = seedFs(state);
			// Herdr disabled: this is pure budget arithmetic, not the recovery
			// ladder — `lastStatus` stays "waiting" and nothing else can return
			// early or extend the deadline out from under the assertion.
			const { layer } = layerOf(fsFake, { herdr: { enabled: false } });
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ poll_ms: 20_000, budget_ms: 95_000 }, ROOT),
				);
				// Four full 20_000ms sleeps land exactly on t=80_000; the fifth
				// sleep must be clamped to the remaining 15_000ms instead of a
				// full 20_000ms. `TestClock.adjust` targets exactly that boundary
				// so it lands on a scheduled wake either way.
				yield* TestClock.adjust(80_000);
				expect(fiber.pollUnsafe()).toBeUndefined(); // four polls done, still running

				yield* TestClock.adjust(15_000); // cumulative 95_000 = the budget
				// `fiber.pollUnsafe()`, not `Fiber.join`: under the mutation the
				// fifth sleep is a full unclamped 20_000 (next wake at
				// t=100_000), so joining here would hang the test instead of
				// failing it cleanly.
				expect(fiber.pollUnsafe()).toBeDefined();

				const result = yield* Effect.result(Fiber.join(fiber));
				expect(Result.isSuccess(result)).toBe(true);
				if (Result.isSuccess(result)) {
					expect(result.success.ok).toBe(true);
					expect(result.success.data?.pending).toBe(true);
				}
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"a non-finite budget_ms is refused before it can silently disable the budget check",
		() => {
			// Every comparison against NaN is false, so an unvalidated NaN slips
			// past both floor gates, makes `budgetEnd` NaN, and `now >= budgetEnd`
			// is false forever — the call blocks until the role's deadline
			// instead of returning exit 3. `registry.ts` reaches `run` through a
			// raw cast with no runtime coercion, so a Pi tool call can carry NaN
			// even though the CLI itself is protected by `parseNumFlag`.
			const t = harness({ timeouts_ms: { default: 900_000 } });
			return Effect.gen(function* () {
				yield* t.dispatch("plan");
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ budget_ms: Number.NaN }, ROOT),
				);
				// Bounded, not `Fiber.join`: under the mutation the call is stuck
				// until the 900_000ms role deadline, so joining here would hang
				// the test instead of failing it. A few seconds of virtual time
				// is enough for the guard to have already returned if it exists.
				yield* TestClock.adjust(5_000);
				expect(fiber.pollUnsafe()).toBeDefined();

				const result = yield* Effect.result(Fiber.join(fiber));
				const e = expectFailure(result, "GateRefused");
				expect(e.message).toContain("finite");
			}).pipe(Effect.provide(t.layer));
		},
	);
});
