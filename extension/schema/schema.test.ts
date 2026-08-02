import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Result } from "effect";
import {
	decodeGlobalConfig,
	decodeProjectConfig,
	GlobalConfigSchema,
} from "./config.ts";
import { decodeFrontMatterResult } from "./frontmatter.ts";
import { decodeRunState, RunStateSchema } from "./state.ts";

const repoRoot = path.resolve(import.meta.dir, "../..");

const fullState = {
	version: 1 as const,
	slug: "demo",
	step: "coding" as const,
	phase_index: 1,
	phase_count_hint: 3,
	rounds: { "phase-01/code_review": 2 },
	vcs: "jj" as const,
	allow_dirty: false,
	goal: "ship phase 1",
	last_error: null,
	pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
	pending_role: "coder" as const,
	pending_pane_id: "p1",
	pending_pane_label: "apnea:coder:abc",
	pending_floating_exit: null,
	role_panes: { coder: { pane_id: "p1", label: "apnea:coder:abc" } },
	package_root: "/tmp/apnea",
	reviewer_tree_fingerprint: null,
	current_phase_package: ".apnea/artifacts/phase-01/round-1/phase-package.md",
	current_code_review: null,
};

describe("RunStateSchema", () => {
	test("round-trips a full fixture", () => {
		const r = decodeRunState(fullState);
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success.slug).toBe("demo");
			expect(r.success.pending_pane_id).toBe("p1");
			expect(r.success.pending_floating_exit).toBeNull();
			expect(r.success.role_panes.coder?.pane_id).toBe("p1");
		}
	});

	test("legacy fixture missing pane fields gets defaults", () => {
		const legacy = {
			version: 1,
			slug: "old",
			step: "planning",
			phase_index: 1,
			phase_count_hint: null,
			rounds: {},
			vcs: "git",
			allow_dirty: true,
			goal: "g",
			last_error: null,
			pending_artifact: null,
			pending_role: null,
			// no pending_pane_*, pending_floating_exit, role_panes
			package_root: "/x",
			reviewer_tree_fingerprint: null,
			current_phase_package: null,
			current_code_review: null,
		};
		const r = decodeRunState(legacy);
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success.pending_pane_id).toBeNull();
			expect(r.success.pending_pane_label).toBeNull();
			expect(r.success.pending_floating_exit).toBeNull();
			expect(r.success.role_panes).toEqual({});
		}
	});

	test("rejects version: 2 and garbage", () => {
		expect(Result.isFailure(decodeRunState({ version: 2 }))).toBe(true);
		expect(Result.isFailure(decodeRunState("nope"))).toBe(true);
		expect(Result.isFailure(decodeRunState({ ...fullState, version: 2 }))).toBe(
			true,
		);
	});

	test("legacy state without dispatch-clock fields decodes with defaults", () => {
		// A run started before the resumable-wait change must still load, or
		// upgrading mid-run would strand the user with a corrupt-state error.
		// `fullState` is the existing fixture; it predates the clock fields, which
		// is exactly the shape a mid-run upgrade encounters on disk.
		const r = decodeRunState({ ...fullState });
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success.pending_started_at).toBeNull();
			expect(r.success.pending_deadline_ms).toBeNull();
			expect(r.success.pending_nudged_at).toBeNull();
			expect(r.success.pending_extended).toBe(false);
			// A `true` default here would skip the final-nudge rung on the first
			// deadline crossing of every pre-existing run, costing an idle role
			// its 180s grace with nothing to catch it.
			expect(r.success.pending_final_grace).toBe(false);
		}
	});

	test("property names drift-guard vs schemas/state.schema.json", () => {
		const jsonPath = path.join(repoRoot, "schemas/state.schema.json");
		const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
			properties: Record<string, unknown>;
		};
		const jsonKeys = Object.keys(doc.properties).sort();
		const schemaKeys = Object.keys(RunStateSchema.fields).sort();
		expect(schemaKeys).toEqual(jsonKeys);
	});
});

describe("config schemas", () => {
	test("global config decodes profiles/roles", () => {
		const r = decodeGlobalConfig({
			profiles: {
				pi: { cmd_interactive: ["pi"] },
			},
			roles: { planner: { profile: "pi" } },
			pane_style: "regular",
		});
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success.profiles.pi?.cmd_interactive).toEqual(["pi"]);
			expect(r.success.review_round_cap).toBe(3);
		}
	});

	test("project config rejects unknown keys", () => {
		const r = decodeProjectConfig({ unknown_key: true });
		expect(Result.isFailure(r)).toBe(true);
		if (Result.isFailure(r)) {
			expect(r.failure._tag).toBe("ConfigError");
			expect(r.failure.message).toContain("unknown project config key");
		}
	});

	test("project config rejects profile-owned keys", () => {
		const r = decodeProjectConfig({ cmd_oneshot: ["x"] });
		expect(Result.isFailure(r)).toBe(true);
	});

	test("property names drift-guard vs schemas/config.schema.json", () => {
		const jsonPath = path.join(repoRoot, "schemas/config.schema.json");
		const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
			properties: Record<string, unknown>;
		};
		const jsonKeys = Object.keys(doc.properties).sort();
		const schemaKeys = Object.keys(GlobalConfigSchema.fields).sort();
		expect(schemaKeys).toEqual(jsonKeys);
	});
});

describe("frontmatter result schema", () => {
	test("accepts APPROVED verdict", () => {
		const r = decodeFrontMatterResult({ status: "done", verdict: "APPROVED" });
		expect(Result.isSuccess(r)).toBe(true);
	});

	test("rejects verdict LGTM", () => {
		const r = decodeFrontMatterResult({ status: "done", verdict: "LGTM" });
		expect(Result.isFailure(r)).toBe(true);
	});
});
