import { Result } from "effect";
import { describe, expect, test } from "bun:test";
import { inferKind } from "./artifact-kind.ts";

describe("inferKind", () => {
	test("all six dispatch kinds", () => {
		expect(Result.getOrThrow(inferKind(".apnea/artifacts/plan.md"))).toBe(
			"plan",
		);
		expect(
			Result.getOrThrow(inferKind(".apnea/artifacts/plan-review/round-1.md")),
		).toBe("plan_review");
		expect(
			Result.getOrThrow(
				inferKind(".apnea/artifacts/phase-01/round-1/phase-package.md"),
			),
		).toBe("phase_package");
		expect(
			Result.getOrThrow(
				inferKind(".apnea/artifacts/phase-01/round-1/coder-result.md"),
			),
		).toBe("code");
		expect(
			Result.getOrThrow(
				inferKind(".apnea/artifacts/phase-01/round-1/code-review.md"),
			),
		).toBe("code_review");
		expect(
			Result.getOrThrow(inferKind(".apnea/artifacts/pr-description.md")),
		).toBe("pr_description");
	});

	test("plan-review/round-1.md → plan_review, not plan (ordering matters)", () => {
		expect(
			Result.getOrThrow(inferKind(".apnea/artifacts/plan-review/round-1.md")),
		).toBe("plan_review");
	});

	test("unknown path → ArtifactInvalid", () => {
		const r = inferKind("README.md");
		expect(Result.isFailure(r)).toBe(true);
		if (Result.isFailure(r)) {
			expect(r.failure._tag).toBe("ArtifactInvalid");
			expect(r.failure.message).toContain("cannot infer dispatch kind");
		}
	});
});
