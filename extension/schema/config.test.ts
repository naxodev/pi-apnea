import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import type { ApneaConfig } from "../lib/types.ts";
import {
	applyProjectConfig,
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
