import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import type { ApneaConfig } from "../domain/types.ts";
import {
	applyProjectConfig,
	decodeGlobalConfig,
	decodeProjectConfig,
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
	// Message text is Schema-generated now (not stable API); assert the failure
	// and the key name only.
	test("invalid value fails decode naming pane_style", () => {
		const g = decodeGlobalConfig({ ...baseRawGlobal, pane_style: "tiled" });
		expect(Result.isFailure(g)).toBe(true);
		if (Result.isFailure(g)) expect(g.failure.message).toContain("pane_style");

		const gBool = decodeGlobalConfig({ ...baseRawGlobal, pane_style: true });
		expect(Result.isFailure(gBool)).toBe(true);
		if (Result.isFailure(gBool)) {
			expect(gBool.failure.message).toContain("pane_style");
		}

		const p = decodeProjectConfig({ pane_style: "tiled" });
		expect(Result.isFailure(p)).toBe(true);
		if (Result.isFailure(p)) expect(p.failure.message).toContain("pane_style");
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
