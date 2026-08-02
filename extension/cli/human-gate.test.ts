import { describe, expect, test } from "bun:test";
import { confirmHuman } from "./human-gate.ts";

const never = async () => {
	throw new Error("prompt must not be called without a TTY");
};

describe("confirmHuman", () => {
	test("refuses a non-TTY caller and names the escape hatch", () => {
		// An agent shelling out gets a pipe, not a terminal. Failing closed here
		// is what keeps the rework cap from being lifted invisibly.
		return confirmHuman("plan_review", { isTty: () => false, prompt: never }, false).then(
			(r) => {
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.reason).toContain("--i-am-human");
			},
		);
	});

	test("accepts when the human retypes the gate key", async () => {
		const r = await confirmHuman(
			"plan_review",
			{ isTty: () => true, prompt: async () => "plan_review" },
			false,
		);
		expect(r.ok).toBe(true);
	});

	test("rejects a mistyped confirmation", async () => {
		// Retyping the gate key is what makes this a decision rather than a
		// reflexive Enter press on a y/n prompt.
		const r = await confirmHuman(
			"plan_review",
			{ isTty: () => true, prompt: async () => "yes" },
			false,
		);
		expect(r.ok).toBe(false);
	});

	test("--i-am-human bypasses the TTY requirement", async () => {
		const r = await confirmHuman("plan_review", { isTty: () => false, prompt: never }, true);
		expect(r.ok).toBe(true);
	});
});
