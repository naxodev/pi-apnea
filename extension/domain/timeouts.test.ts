import { describe, expect, test } from "bun:test";
import { DISPATCH_KINDS } from "./state-machine.ts";
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

	test("pr_description honours the documented `finishing` key", () => {
		// `finishing` is a real merged key (DEFAULT_TIMEOUTS in domain/types.ts),
		// so a user who sets it expects the PR-description role to get it.
		// Mapping this kind to no key made that config silently unreachable —
		// wait would time out at the default and dispatch would report the
		// default back, leaving no way to tell the value had been dropped.
		const t = { finishing: 2_700_000, default: 600_000 };
		expect(timeoutMsForKind("pr_description", t)).toBe(2_700_000);
	});

	test("every dispatch kind maps to a key some config can reach", () => {
		// Guards the regression directly: with a kind mapped to no key, the
		// per-kind lookup collapses to `default` and this fails.
		for (const kind of DISPATCH_KINDS) {
			// The key a kind resolves to is an implementation detail; what
			// matters is that SOME documented setting beats `default`.
			const configured = timeoutMsForKind(kind, {
				planning: 11_000,
				plan_review: 12_000,
				phase_packaging: 13_000,
				coding: 14_000,
				code_review: 15_000,
				finishing: 16_000,
				default: 999_999,
			});
			expect(configured).not.toBe(999_999);
		}
	});
});
