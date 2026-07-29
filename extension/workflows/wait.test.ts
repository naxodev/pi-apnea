import { describe, expect } from "bun:test";
import { Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { statePath } from "../domain/paths.ts";
import type { RunState } from "../domain/types.ts";
import { fakeConfigLayer } from "../test/fake-config.ts";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { fakeHerdrLayer, type FakeHerdrOptions } from "../test/fake-herdr.ts";
import { fakeVcsLayer } from "../test/fake-vcs.ts";
import { itEffect } from "../test/it-effect.ts";
import { RunStoreLive } from "../services/run-store.ts";
import { waitWorkflow } from "./wait.ts";

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
			});
			const fsFake = seedFs(state, {
				[`${ROOT}/.apnea/artifacts/phase-01/round-1/code-review.md`]:
					"---\nstatus: done\n---\nbody",
			});
			const { layer, fakeFs } = layerOf(fsFake);
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ timeout_ms: 5_000, poll_ms: 1_000 }, ROOT),
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
					waitWorkflow({ timeout_ms: 60_000, poll_ms: 5_000 }, ROOT, {
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
					waitWorkflow({ timeout_ms: 60_000, poll_ms: 500 }, ROOT),
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
					waitWorkflow({ timeout_ms: 60_000, poll_ms: 500 }, ROOT),
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
					waitWorkflow({ timeout_ms: 60_000, poll_ms: 1_000 }, ROOT),
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
					waitWorkflow({ timeout_ms: 60_000, poll_ms: 1_000 }, ROOT),
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
					waitWorkflow({ timeout_ms: 600_000, poll_ms: 1_000 }, ROOT),
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
					pane: () => ({ ok: true, agent_status: "working" }),
				},
			});
			const timeout = 100_000; // 50% = 50000 < 120000 floor, so extension = 120000
			return Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitWorkflow({ timeout_ms: timeout, poll_ms: 1_000 }, ROOT),
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
});
