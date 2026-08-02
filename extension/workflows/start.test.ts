/**
 * Fake-layer unit tests for start/status/reset + a few temp-dir smokes
 * that still exercise real AppLive (status with no state / corrupt).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { statePath } from "../domain/paths.ts";
import { ConfigError } from "../errors.ts";
import type { RunState } from "../domain/types.ts";
import { workflowStart } from "../adapters/start.ts";
import {
	workflowResetRounds,
	workflowStatus,
} from "../adapters/status.ts";
import { expectFailure } from "../test/expect-failure.ts";
import { fakeConfigLayer } from "../test/fake-config.ts";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { fakeVcsLayer } from "../test/fake-vcs.ts";
import { itEffect } from "../test/it-effect.ts";
import { RunStoreLive } from "../services/run-store.ts";
import { startWorkflow } from "./start.ts";
import { statusWorkflow } from "./status.ts";
import { resetRoundsWorkflow } from "./reset.ts";

const ROOT = "/proj";

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

describe("startWorkflow (fake layers)", () => {
	itEffect("dirty tree → GateRefused clean_tree", () => {
		const fsFake = makeFakeFileSystem();
		const { layer } = layerOf(fsFake, { detect: "git", dirty: true });
		return Effect.gen(function* () {
			const r = yield* Effect.result(
				startWorkflow({ goal: "x", slug: "x" }, ROOT),
			);
			const e = expectFailure(r, "GateRefused");
			expect(e.gate).toBe("clean_tree");
		}).pipe(Effect.provide(layer));
	});

	itEffect("allow_dirty: true bypasses dirty check", () => {
		const fsFake = makeFakeFileSystem();
		const { layer, vcs } = layerOf(fsFake, { detect: "git", dirty: true });
		return Effect.gen(function* () {
			const result = yield* startWorkflow(
				{ goal: "x", slug: "dirty-ok", allow_dirty: true },
				ROOT,
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data?.next).toBe("dispatch_role");
				expect(result.data?.next_args).toEqual({ kind: "plan" });
				expect(result.legal_next).toEqual(["dispatch_role", "workflow_wait"]);
				expect(result.data?.note).toContain("does not launch roles");
			}
			expect(vcs.ensureBranches).toEqual([
				{ root: ROOT, slug: "dirty-ok" },
			]);
		}).pipe(Effect.provide(layer));
	});

	itEffect("ConfigError surfaces from config.load", () => {
		const fsFake = makeFakeFileSystem();
		const { layer } = layerOf(
			fsFake,
			{ detect: "jj" },
			{
				failLoad: new ConfigError({
					message: "missing global config at /tmp/x",
					path: "/tmp/x",
				}),
			},
		);
		return Effect.gen(function* () {
			const r = yield* Effect.result(
				startWorkflow({ goal: "x", slug: "x" }, ROOT),
			);
			expectFailure(r, "ConfigError");
		}).pipe(Effect.provide(layer));
	});

	itEffect("git backend → ensureGitBranch recorded", () => {
		const fsFake = makeFakeFileSystem();
		const { layer, vcs } = layerOf(fsFake, { detect: "git", dirty: false });
		return Effect.gen(function* () {
			const result = yield* startWorkflow(
				{ goal: "branch me", slug: "br" },
				ROOT,
			);
			expect(result.ok).toBe(true);
			expect(vcs.ensureBranches).toEqual([{ root: ROOT, slug: "br" }]);
		}).pipe(Effect.provide(layer));
	});

	itEffect("start tells the caller to dispatch the planner next", () => {
		// Stopping after start is the single most common orchestration failure.
		// The result itself has to say what comes next.
		const fsFake = makeFakeFileSystem();
		const { layer } = layerOf(fsFake, { detect: "git", dirty: false });
		return Effect.gen(function* () {
			const r = yield* startWorkflow({ goal: "x" }, ROOT);
			expect(r.ok).toBe(true);
			expect(r.legal_next).toContain("dispatch_role");
		}).pipe(Effect.provide(layer));
	});

	itEffect("no vcs → VcsError", () => {
		const fsFake = makeFakeFileSystem();
		const { layer } = layerOf(fsFake, { detect: null });
		return Effect.gen(function* () {
			const r = yield* Effect.result(
				startWorkflow({ goal: "x", slug: "x" }, ROOT),
			);
			const e = expectFailure(r, "VcsError");
			expect(e.message).toContain("no .jj or .git");
		}).pipe(Effect.provide(layer));
	});

	itEffect("double start → GateRefused", () => {
		const existing: RunState = {
			version: 1,
			slug: "ex",
			step: "planning",
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
			pending_started_at: null,
			pending_deadline_ms: null,
			pending_nudged_at: null,
			pending_extended: false,
			role_panes: {},
			package_root: "/pkg",
			reviewer_tree_fingerprint: null,
			current_phase_package: null,
			current_code_review: null,
		};
		const fsFake = makeFakeFileSystem({
			[statePath(ROOT)]: `${JSON.stringify(existing, null, 2)}\n`,
		});
		const { layer } = layerOf(fsFake);
		return Effect.gen(function* () {
			const r = yield* Effect.result(
				startWorkflow({ goal: "nope" }, ROOT),
			);
			const e = expectFailure(r, "GateRefused");
			expect(e.message).toContain("already exists");
			expect(e.details?.slug).toBe("ex");
		}).pipe(Effect.provide(layer));
	});

	itEffect("abandon on corrupt state succeeds", () => {
		const fsFake = makeFakeFileSystem({
			[statePath(ROOT)]: "{bad",
		});
		const { layer, fakeFs } = layerOf(fsFake);
		return Effect.gen(function* () {
			const result = yield* startWorkflow(
				{ goal: "", action: "abandon" },
				ROOT,
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(String(result.data?.backup)).toContain("abandoned");
			}
			expect(fakeFs.files.has(statePath(ROOT))).toBe(false);
		}).pipe(Effect.provide(layer));
	});

	itEffect("resume: pending_status classification and hint", () => {
		const pendingPath = ".apnea/artifacts/phase-01/round-1/coder-result.md";
		const stateWithPending = (pending: string | null): RunState => ({
			version: 1,
			slug: "ex",
			step: "planning",
			phase_index: 1,
			phase_count_hint: null,
			rounds: {},
			vcs: "jj",
			allow_dirty: false,
			goal: "g",
			last_error: null,
			pending_artifact: pending,
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
		});

		return Effect.gen(function* () {
			const existsFs = makeFakeFileSystem({
				[statePath(ROOT)]: `${JSON.stringify(stateWithPending(pendingPath), null, 2)}\n`,
				[`${ROOT}/${pendingPath}`]: "content",
			});
			const r1 = yield* startWorkflow(
				{ goal: "g", action: "resume" },
				ROOT,
			).pipe(Effect.provide(layerOf(existsFs).layer));
			expect(r1.ok).toBe(true);
			if (r1.ok) {
				expect(r1.data?.pending_status).toBe("artifact_exists");
				expect(r1.data?.hint).toContain("workflow_wait");
			}

			const missingFs = makeFakeFileSystem({
				[statePath(ROOT)]: `${JSON.stringify(stateWithPending(pendingPath), null, 2)}\n`,
			});
			const r2 = yield* startWorkflow(
				{ goal: "g", action: "resume" },
				ROOT,
			).pipe(Effect.provide(layerOf(missingFs).layer));
			expect(r2.ok).toBe(true);
			if (r2.ok) {
				expect(r2.data?.pending_status).toBe("artifact_missing");
				expect(r2.data?.hint).toContain("re-dispatch");
			}

			const noneFs = makeFakeFileSystem({
				[statePath(ROOT)]: `${JSON.stringify(stateWithPending(null), null, 2)}\n`,
			});
			const r3 = yield* startWorkflow(
				{ goal: "g", action: "resume" },
				ROOT,
			).pipe(Effect.provide(layerOf(noneFs).layer));
			expect(r3.ok).toBe(true);
			if (r3.ok) {
				expect(r3.data?.pending_status).toBe("none");
				expect(r3.data?.hint).toContain("workflow_status");
			}
		});
	});
});

describe("statusWorkflow (fake layers)", () => {
	itEffect("failing config yields config_error while tool succeeds", () => {
		const existing: RunState = {
			version: 1,
			slug: "ex",
			step: "planning",
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
			pending_started_at: null,
			pending_deadline_ms: null,
			pending_nudged_at: null,
			pending_extended: false,
			role_panes: {},
			package_root: "/pkg",
			reviewer_tree_fingerprint: null,
			current_phase_package: null,
			current_code_review: null,
		};
		const fsFake = makeFakeFileSystem({
			[statePath(ROOT)]: `${JSON.stringify(existing, null, 2)}\n`,
		});
		const { layer } = layerOf(
			fsFake,
			{ detect: "jj", dirty: false },
			{
				failLoad: new ConfigError({
					message: "boom config",
					path: "/x",
				}),
			},
		);
		return Effect.gen(function* () {
			const result = yield* statusWorkflow(ROOT);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data?.config).toEqual({
					config_error: "boom config",
				});
				expect(result.data?.dirty).toBe(false);
				expect(result.data?.legal_tools).toBeDefined();
			}
		}).pipe(Effect.provide(layer));
	});
});

describe("resetRoundsWorkflow (fake layers)", () => {
	itEffect("zeros counter", () => {
		const existing: RunState = {
			version: 1,
			slug: "ex",
			step: "planning",
			phase_index: 1,
			phase_count_hint: null,
			rounds: { plan_review: 3 },
			vcs: "jj",
			allow_dirty: false,
			goal: "g",
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
		};
		const fsFake = makeFakeFileSystem({
			[statePath(ROOT)]: `${JSON.stringify(existing, null, 2)}\n`,
		});
		const { layer } = layerOf(fsFake);
		return Effect.gen(function* () {
			const result = yield* resetRoundsWorkflow(
				{ gate: "plan_review" },
				ROOT,
			);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.message).toContain("3 → 1");
		}).pipe(Effect.provide(layer));
	});
});

// --- temp-dir AppLive smoke (no fake VCS) ---
const dirs: string[] = [];
const origCwd = process.cwd();

afterEach(() => {
	process.chdir(origCwd);
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function gitRepo(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-wf-"));
	dirs.push(d);
	spawnSync("git", ["init"], { cwd: d });
	spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: d });
	spawnSync("git", ["config", "user.name", "t"], { cwd: d });
	fs.writeFileSync(path.join(d, "README"), "x\n");
	spawnSync("git", ["add", "."], { cwd: d });
	spawnSync("git", ["commit", "-m", "init"], { cwd: d });
	return d;
}

describe("start/status adapters (temp dir)", () => {
	test("status with no state → ok has_state:false", async () => {
		const d = gitRepo();
		process.chdir(d);
		const st = await workflowStatus();
		expect(st.ok).toBe(true);
		if (st.ok) expect(st.data?.has_state).toBe(false);
	});

	// `apnea status` is the likely first command a cold agent runs on a fresh
	// checkout. Without a legal_next hint here, the self-describing promise
	// breaks exactly at cold start — the agent gets no pointer to workflow_start.
	test("status with no state → legal_next points at workflow_start", async () => {
		const d = gitRepo();
		process.chdir(d);
		const st = await workflowStatus();
		expect(st.legal_next).toEqual(["workflow_start"]);
	});

	test("reset-rounds on missing state → ok:false no-run-state", async () => {
		const d = gitRepo();
		process.chdir(d);
		const r = await workflowResetRounds({ gate: "plan_review" });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/no run state/i);
			expect(r.legal_next).toContain("workflow_start");
		}
	});

	test("corrupt state.json → StateCorrupt message", async () => {
		const d = gitRepo();
		fs.mkdirSync(path.join(d, ".apnea"), { recursive: true });
		fs.writeFileSync(path.join(d, ".apnea", "state.json"), "{bad");
		process.chdir(d);

		const st = await workflowStatus();
		expect(st.ok).toBe(false);
		if (!st.ok) expect(st.error).toContain("corrupt state");

		const start = await workflowStart({ goal: "x", action: "resume" });
		expect(start.ok).toBe(false);
		if (!start.ok) expect(start.error).toContain("corrupt state");
	});
});
