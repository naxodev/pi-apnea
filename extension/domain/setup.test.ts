import { describe, expect, test } from "bun:test";
import {
	buildGlobalConfig,
	buildProfiles,
	deepMergeProfiles,
	detectionNotes,
	pickRoles,
	preservePaneStyle,
	type Detected,
} from "./setup.ts";

function detected(overrides: Partial<Detected> = {}): Detected {
	return {
		pi: true,
		claude: false,
		codex: false,
		herdr: false,
		jj: false,
		git: false,
		...overrides,
	};
}

describe("preservePaneStyle", () => {
	// Setup must never silently drop a user's floating opt-in on re-run (or --force).
	test("prev floating/regular survive; absent stays absent; invalid dropped", () => {
		expect(preservePaneStyle({ pane_style: "floating" })).toBe("floating");
		expect(preservePaneStyle({ pane_style: "regular" })).toBe("regular");
		expect(preservePaneStyle({})).toBeUndefined();
		expect(preservePaneStyle({ pane_style: "tiled" })).toBeUndefined();
		expect(preservePaneStyle({ pane_style: 1 })).toBeUndefined();
	});
});

describe("deepMergeProfiles", () => {
	test("existing keys win over incoming; new keys are added", () => {
		const merged = deepMergeProfiles(
			{ "pi-grok": { edited: true } },
			{ "pi-grok": { edited: false }, "pi-default": { cmd_interactive: ["pi"] } },
		);
		expect(merged["pi-grok"]).toEqual({ edited: true });
		expect(merged["pi-default"]).toEqual({ cmd_interactive: ["pi"] });
	});
});

describe("buildProfiles / pickRoles", () => {
	// A wrong binding silently runs the wrong harness for every dispatch.
	test("planner/reviewer bind to claude-fable when claude exists", () => {
		const has = detected({ claude: true });
		const profiles = buildProfiles(has);
		expect(profiles["claude-fable"]).toBeDefined();
		const roles = pickRoles(has);
		expect(roles.planner).toEqual({ profile: "claude-fable" });
		expect(roles.reviewer).toEqual({ profile: "claude-fable" });
	});

	test("planner/reviewer bind to codex when only codex exists", () => {
		const has = detected({ codex: true });
		const profiles = buildProfiles(has);
		expect(profiles["codex"]).toBeDefined();
		expect(profiles["claude-fable"]).toBeUndefined();
		const roles = pickRoles(has);
		expect(roles.planner).toEqual({ profile: "codex" });
		expect(roles.reviewer).toEqual({ profile: "codex" });
	});

	test("planner/reviewer bind to pi-default when neither claude nor codex exists", () => {
		const has = detected();
		const roles = pickRoles(has);
		expect(roles.planner).toEqual({ profile: "pi-default" });
		expect(roles.reviewer).toEqual({ profile: "pi-default" });
	});

	test("coder/orchestrator always bind to pi-grok", () => {
		for (const has of [
			detected(),
			detected({ claude: true }),
			detected({ codex: true }),
		]) {
			const roles = pickRoles(has);
			expect(roles.coder).toEqual({ profile: "pi-grok" });
			expect(roles.orchestrator).toEqual({ profile: "pi-grok" });
		}
	});
});

describe("buildGlobalConfig", () => {
	test("merge keeps an unknown pre-existing profile; force drops it", () => {
		const prev = { profiles: { custom: { cmd_interactive: ["custom"] } } };
		const merged = buildGlobalConfig({ has: detected(), prev, force: false });
		expect((merged.profiles as Record<string, unknown>).custom).toBeDefined();

		const forced = buildGlobalConfig({ has: detected(), prev, force: true });
		expect((forced.profiles as Record<string, unknown>).custom).toBeUndefined();
	});

	test("prev.roles preserved without force, replaced with force", () => {
		const prev = { roles: { coder: { profile: "custom" } } };
		const kept = buildGlobalConfig({ has: detected(), prev, force: false });
		expect(kept.roles).toEqual(prev.roles);

		const replaced = buildGlobalConfig({ has: detected(), prev, force: true });
		expect(replaced.roles).not.toEqual(prev.roles);
	});

	test("review_round_cap / timeouts_ms preserved when present, defaulted when absent", () => {
		const withPrev = buildGlobalConfig({
			has: detected(),
			prev: { review_round_cap: 7, timeouts_ms: { verify: 5000 } },
			force: false,
		});
		expect(withPrev.review_round_cap).toBe(7);
		expect(withPrev.timeouts_ms).toEqual({ verify: 5000 });

		const withoutPrev = buildGlobalConfig({ has: detected(), prev: {}, force: false });
		expect(withoutPrev.review_round_cap).toBe(3);
		expect(withoutPrev.timeouts_ms).toEqual({
			planning: 1_500_000,
			plan_review: 900_000,
			phase_packaging: 900_000,
			coding: 2_700_000,
			code_review: 900_000,
			verify: 900_000,
		});
	});

	test("pane_style absent when prev has none, present when valid, dropped when garbage", () => {
		const absent = buildGlobalConfig({ has: detected(), prev: {}, force: false });
		expect("pane_style" in absent).toBe(false);

		const present = buildGlobalConfig({
			has: detected(),
			prev: { pane_style: "floating" },
			force: false,
		});
		expect(present.pane_style).toBe("floating");

		const garbage = buildGlobalConfig({
			has: detected(),
			prev: { pane_style: "tiled" },
			force: false,
		});
		expect("pane_style" in garbage).toBe(false);
	});
});

describe("detectionNotes", () => {
	test("no claude/codex note", () => {
		expect(detectionNotes(detected())).toContain(
			"no claude/codex — planner/reviewer bound to pi-default (edit global profiles to change)",
		);
		expect(detectionNotes(detected({ claude: true }))).not.toContain(
			"no claude/codex — planner/reviewer bound to pi-default (edit global profiles to change)",
		);
	});

	test("no herdr note", () => {
		expect(detectionNotes(detected())).toContain(
			"herdr not on PATH — pane launch will fail until installed",
		);
		expect(detectionNotes(detected({ herdr: true }))).not.toContain(
			"herdr not on PATH — pane launch will fail until installed",
		);
	});

	test("no jj/git note", () => {
		expect(detectionNotes(detected())).toContain(
			"neither jj nor git on PATH — commits will refuse",
		);
		expect(detectionNotes(detected({ jj: true }))).not.toContain(
			"neither jj nor git on PATH — commits will refuse",
		);
		expect(detectionNotes(detected({ git: true }))).not.toContain(
			"neither jj nor git on PATH — commits will refuse",
		);
	});
});
