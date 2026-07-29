import { describe, expect, test } from "bun:test";
import { timeoutMsForKind } from "./timeouts.ts";

describe("timeoutMsForKind", () => {
	test("prefers the step-specific key over default", () => {
		// config.md documents per-step timeouts; a coder gets far longer than a
		// reviewer, and collapsing them to one number would starve long phases.
		const t = { coding: 2_700_000, default: 900_000 };
		expect(timeoutMsForKind("code", t)).toBe(2_700_000);
	});

	test("falls back to default when the step key is absent", () => {
		expect(timeoutMsForKind("code", { default: 600_000 })).toBe(600_000);
	});

	test("falls back to 900s when config sets nothing", () => {
		expect(timeoutMsForKind("code", {})).toBe(900_000);
	});

	test("pr_description has no dedicated key and uses default", () => {
		const t = { planning: 1_500_000, default: 600_000 };
		expect(timeoutMsForKind("pr_description", t)).toBe(600_000);
	});
});
