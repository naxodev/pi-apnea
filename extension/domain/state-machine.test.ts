import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import {
	LEGAL_TOOLS,
	allowedKinds,
	stepAfterArtifact,
	toolAllowed,
} from "./state-machine.ts";

describe("state machine", () => {
	test("commit only legal in committing", () => {
		expect(LEGAL_TOOLS.committing).toContain("workflow_commit_phase");
		expect(LEGAL_TOOLS.coding).not.toContain("workflow_commit_phase");
	});

	test("status never missing", () => {
		for (const step of Object.keys(LEGAL_TOOLS)) {
			expect(LEGAL_TOOLS[step as keyof typeof LEGAL_TOOLS]).toContain(
				"workflow_status",
			);
		}
	});

	test("plan_review APPROVED → phase_packaging", () => {
		expect(stepAfterArtifact("plan_review", "APPROVED")).toBe(
			"phase_packaging",
		);
		expect(stepAfterArtifact("plan_review", "CHANGES_REQUIRED")).toBe(
			"planning",
		);
	});

	test("code_review APPROVED → committing", () => {
		expect(stepAfterArtifact("code_review", "APPROVED")).toBe("committing");
		expect(stepAfterArtifact("code_review", "CHANGES_REQUIRED")).toBe("coding");
	});

	test("allowed kinds at plan_review include plan rework", () => {
		expect(allowedKinds("plan_review")).toContain("plan");
		expect(allowedKinds("coding")).toEqual(["code"]);
	});

	test("toolAllowed succeeds for legal tool", () => {
		const r = toolAllowed("coding", "dispatch_role");
		expect(Result.isSuccess(r)).toBe(true);
	});

	test("toolAllowed fails with IllegalTool + legal list", () => {
		const r = toolAllowed("done", "dispatch_role");
		expect(Result.isFailure(r)).toBe(true);
		if (Result.isFailure(r)) {
			expect(r.failure._tag).toBe("IllegalTool");
			expect(r.failure.step).toBe("done");
			expect(r.failure.tool).toBe("dispatch_role");
			expect(r.failure.legal).toEqual(["workflow_status"]);
		}
	});
});
