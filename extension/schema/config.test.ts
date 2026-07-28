import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import type { ApneaConfig } from "../domain/types.ts";
import { expectFailure } from "../test/expect-failure.ts";
import {
	applyProjectConfig,
	decodeGlobalConfig,
	decodeProjectConfig,
	PaneStyleSchema,
	validateRoleBindings,
} from "./config.ts";

const base: ApneaConfig = {
	profiles: {
		pi: { cmd_interactive: ["pi"] },
		claude: {
			cmd_interactive: ["claude"],
			cmd_oneshot: ["claude", "-p"],
		},
	},
	roles: {
		planner: { profile: "pi" },
		reviewer: { profile: "pi" },
		coder: { profile: "pi" },
	},
	review_round_cap: 3,
	timeouts_ms: { verify: 900_000, coding: 2_700_000 },
	pane_style: "regular",
};

const baseRawGlobal = {
	profiles: { pi: { cmd_interactive: ["pi"] } },
	roles: {
		planner: { profile: "pi" },
		reviewer: { profile: "pi" },
		coder: { profile: "pi" },
	},
};

describe("pane_style", () => {
	// Existing users who never heard of this key must see zero behavior change.
	test("omitted everywhere defaults to regular", () => {
		const r = decodeGlobalConfig(baseRawGlobal);
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) expect(r.success.pane_style).toBe("regular");
	});

	test("global floating is respected", () => {
		const r = decodeGlobalConfig({ ...baseRawGlobal, pane_style: "floating" });
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) expect(r.success.pane_style).toBe("floating");
	});

	// Project UX preference must win over global in both directions.
	test("project overlay wins both directions", () => {
		const fromRegular = applyProjectConfig(
			{ ...base, pane_style: "regular" },
			{ pane_style: "floating" },
		);
		expect(fromRegular.pane_style).toBe("floating");

		const fromFloating = applyProjectConfig(
			{ ...base, pane_style: "floating" },
			{ pane_style: "regular" },
		);
		expect(fromFloating.pane_style).toBe("regular");
	});

	// An unrelated project config must not silently reset the preference.
	test("project silent on the key inherits global", () => {
		const floatingBase: ApneaConfig = { ...base, pane_style: "floating" };
		expect(applyProjectConfig(floatingBase, {}).pane_style).toBe("floating");
		expect(
			applyProjectConfig(floatingBase, { review_round_cap: 2 }).pane_style,
		).toBe("floating");
	});

	// Orchestrator runs unattended — a typo must fail at config load, not mid-run.
	// Message text is Schema-generated, so assert *containment* of the key name
	// and of each allowed value derived from `PaneStyleSchema.literals`, rather
	// than matching the message shape.
	test("invalid value fails decode naming pane_style", () => {
		const g = decodeGlobalConfig({ ...baseRawGlobal, pane_style: "tiled" });
		const ge = expectFailure(g, "ConfigError");
		expect(ge.message).toContain("pane_style");
		for (const allowed of PaneStyleSchema.literals) {
			expect(ge.message).toContain(allowed);
		}

		const gBool = decodeGlobalConfig({ ...baseRawGlobal, pane_style: true });
		const gBoolE = expectFailure(gBool, "ConfigError");
		expect(gBoolE.message).toContain("pane_style");
		for (const allowed of PaneStyleSchema.literals) {
			expect(gBoolE.message).toContain(allowed);
		}

		const p = decodeProjectConfig({ pane_style: "tiled" });
		const pe = expectFailure(p, "ConfigError");
		expect(pe.message).toContain("pane_style");
		for (const allowed of PaneStyleSchema.literals) {
			expect(pe.message).toContain(allowed);
		}
	});

	// pane_style is a UX preference, not a forbidden project key.
	test("project pane_style is not rejected as unknown", () => {
		const r = decodeProjectConfig({ pane_style: "floating" });
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) expect(r.success.pane_style).toBe("floating");
	});
});

describe("applyProjectConfig", () => {
	test("role override per-key; profiles untouched", () => {
		const merged = applyProjectConfig(base, {
			roles: { coder: { profile: "claude" } },
		});
		expect(merged.roles.coder).toEqual({ profile: "claude" });
		expect(merged.roles.planner).toEqual({ profile: "pi" });
		expect(merged.profiles).toBe(base.profiles);
		expect(merged.profiles).toEqual(base.profiles);
	});

	test("timeouts merge per-key", () => {
		const merged = applyProjectConfig(base, {
			timeouts_ms: { verify: 60_000 },
		});
		expect(merged.timeouts_ms.verify).toBe(60_000);
		expect(merged.timeouts_ms.coding).toBe(2_700_000);
	});

	test("review_round_cap and pane_style fall back to base when absent", () => {
		const merged = applyProjectConfig(base, {});
		expect(merged.review_round_cap).toBe(3);
		expect(merged.pane_style).toBe("regular");
	});

	test("review_round_cap and pane_style taken from overlay when present", () => {
		const merged = applyProjectConfig(base, {
			review_round_cap: 5,
			pane_style: "floating",
		});
		expect(merged.review_round_cap).toBe(5);
		expect(merged.pane_style).toBe("floating");
	});

	// Out-of-range overlay values fall back rather than propagate: a project
	// config is a shared, checked-in file, and cap=0 would deadlock every review.
	test("out-of-range overlay values fall back to base", () => {
		const merged = applyProjectConfig(base, {
			review_round_cap: 0,
			timeouts_ms: { verify: 500 },
		});
		expect(merged.review_round_cap).toBe(3);
		expect(merged.timeouts_ms.verify).toBe(900_000);
	});
});

/**
 * A hand-edited config with an out-of-range number must degrade to the default,
 * not fail the decode: `config.load` runs inside every tool, so a hard failure
 * here refuses workflow_start / dispatch_role / wait / commit alike, leaving no
 * way to recover from inside Pi.
 */
describe("out-of-range numbers degrade instead of failing the decode", () => {
	test("global timeouts_ms below the 1000ms floor fall back to defaults", () => {
		const r = decodeGlobalConfig({
			...baseRawGlobal,
			timeouts_ms: { verify: 500, coding: 1_800_000 },
		});
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) {
			expect(r.success.timeouts_ms.verify).toBe(900_000); // DEFAULT_TIMEOUTS
			expect(r.success.timeouts_ms.coding).toBe(1_800_000); // in range, kept
		}
	});

	test("global review_round_cap below 1 falls back to 3", () => {
		const r = decodeGlobalConfig({ ...baseRawGlobal, review_round_cap: 0 });
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) expect(r.success.review_round_cap).toBe(3);
	});

	test("project overlay with an out-of-range number still decodes", () => {
		const r = decodeProjectConfig({
			review_round_cap: 0,
			timeouts_ms: { verify: 500 },
		});
		expect(Result.isSuccess(r)).toBe(true);
	});

	// Wrong *type* is still a hard failure — that is a malformed file, not a
	// value the defaults can stand in for.
	test("non-numeric timeout is still rejected", () => {
		const r = decodeGlobalConfig({
			...baseRawGlobal,
			timeouts_ms: { verify: "900000" },
		});
		expect(Result.isFailure(r)).toBe(true);
	});
});

describe("validateRoleBindings", () => {
	test("success returns cfg unchanged", () => {
		const r = validateRoleBindings(base);
		expect(Result.isSuccess(r)).toBe(true);
		if (Result.isSuccess(r)) expect(r.success).toBe(base);
	});

	test("missing role → ConfigError", () => {
		const cfg: ApneaConfig = {
			...base,
			roles: { planner: { profile: "pi" }, reviewer: { profile: "pi" } },
		};
		const r = validateRoleBindings(cfg);
		expect(Result.isFailure(r)).toBe(true);
		if (Result.isFailure(r)) {
			expect(r.failure.message).toBe("config missing roles.coder");
		}
	});

	test("unknown profile → ConfigError", () => {
		const cfg: ApneaConfig = {
			...base,
			roles: {
				...base.roles,
				coder: { profile: "missing" },
			},
		};
		const r = validateRoleBindings(cfg);
		expect(Result.isFailure(r)).toBe(true);
		if (Result.isFailure(r)) {
			expect(r.failure.message).toBe(
				'roles.coder profile "missing" not defined in global profiles',
			);
		}
	});

	test("profile missing cmd for role mode → ConfigError", () => {
		// All roles are interactive in ROLE_MODE; use a profile with only oneshot.
		const cfg: ApneaConfig = {
			...base,
			profiles: {
				oneshotOnly: { cmd_oneshot: ["x", "-p"] },
			},
			roles: {
				planner: { profile: "oneshotOnly" },
				reviewer: { profile: "oneshotOnly" },
				coder: { profile: "oneshotOnly" },
			},
		};
		const r = validateRoleBindings(cfg);
		expect(Result.isFailure(r)).toBe(true);
		if (Result.isFailure(r)) {
			expect(r.failure.message).toBe(
				'profile "oneshotOnly" missing cmd_interactive required by role planner',
			);
		}
	});
});
