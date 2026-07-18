import type { Role, Step } from "./types.ts";

/** Legal next steps after a successful transition from `step`. */
export const LEGAL_TOOLS: Record<
	Step,
	Array<
		| "workflow_start"
		| "dispatch_role"
		| "workflow_wait"
		| "workflow_commit_phase"
		| "workflow_status"
		| "workflow_reset_rounds"
	>
> = {
	planning: [
		"dispatch_role",
		"workflow_wait",
		"workflow_status",
		"workflow_reset_rounds",
	],
	plan_review: [
		"dispatch_role",
		"workflow_wait",
		"workflow_status",
		"workflow_reset_rounds",
	],
	phase_packaging: [
		"dispatch_role",
		"workflow_wait",
		"workflow_status",
		"workflow_reset_rounds",
	],
	coding: [
		"dispatch_role",
		"workflow_wait",
		"workflow_status",
		"workflow_reset_rounds",
	],
	code_review: [
		"dispatch_role",
		"workflow_wait",
		"workflow_status",
		"workflow_reset_rounds",
	],
	committing: ["workflow_commit_phase", "workflow_status"],
	finishing: ["dispatch_role", "workflow_wait", "workflow_status"],
	done: ["workflow_status"],
};

export type DispatchKind =
	| "plan"
	| "plan_review"
	| "phase_package"
	| "code"
	| "code_review"
	| "pr_description";

export function expectedRole(kind: DispatchKind): Role {
	switch (kind) {
		case "plan":
		case "phase_package":
		case "pr_description":
			return "planner";
		case "plan_review":
		case "code_review":
			return "reviewer";
		case "code":
			return "coder";
	}
}

export function allowedKinds(step: Step): DispatchKind[] {
	switch (step) {
		case "planning":
			return ["plan"];
		case "plan_review":
			return ["plan_review", "plan"]; // plan = rework after CHANGES_REQUIRED
		case "phase_packaging":
			return ["phase_package"];
		case "coding":
			return ["code"];
		case "code_review":
			return ["code_review", "code"];
		case "finishing":
			return ["pr_description"];
		default:
			return [];
	}
}

export function stepAfterDispatch(kind: DispatchKind, step: Step): Step {
	// dispatch does not always change step; wait does for completion
	void kind;
	return step;
}

export function stepAfterArtifact(
	kind: DispatchKind,
	verdict: string | undefined,
): Step | { error: string } {
	switch (kind) {
		case "plan":
			return "plan_review";
		case "plan_review":
			if (verdict === "APPROVED") return "phase_packaging";
			if (verdict === "CHANGES_REQUIRED") return "planning";
			return { error: "plan_review artifact missing verdict" };
		case "phase_package":
			return "coding";
		case "code":
			return "code_review";
		case "code_review":
			if (verdict === "APPROVED") return "committing";
			if (verdict === "CHANGES_REQUIRED") return "coding";
			return { error: "code_review artifact missing verdict" };
		case "pr_description":
			return "done";
	}
}

export function assertToolAllowed(
	step: Step,
	tool: keyof (typeof LEGAL_TOOLS)[Step] extends never
		? string
		: (typeof LEGAL_TOOLS)[Step][number],
): void {
	const legal = LEGAL_TOOLS[step];
	if (!legal.includes(tool as (typeof legal)[number])) {
		throw Object.assign(
			new Error(
				`illegal tool ${tool} at step=${step}. legal: ${legal.join(", ") || "(none)"}`,
			),
			{ legal_next: legal },
		);
	}
}
