import { Result } from "effect";
import { IllegalTool } from "../errors.ts";
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
	>
> = {
	planning: ["dispatch_role", "workflow_wait", "workflow_status"],
	plan_review: ["dispatch_role", "workflow_wait", "workflow_status"],
	phase_packaging: ["dispatch_role", "workflow_wait", "workflow_status"],
	coding: ["dispatch_role", "workflow_wait", "workflow_status"],
	code_review: ["dispatch_role", "workflow_wait", "workflow_status"],
	committing: ["workflow_commit_phase", "workflow_status"],
	finishing: ["dispatch_role", "workflow_wait", "workflow_status"],
	done: ["workflow_status"],
};

export type ToolName = (typeof LEGAL_TOOLS)[Step][number];

/**
 * Actionable next calls for a step: `LEGAL_TOOLS` minus the read-only
 * snapshot. An agent follows this list literally, so it must contain only
 * calls that move the run forward. The human-only cap reset (`reset-rounds`)
 * is never a Pi tool at all — see `registry.ts` — so it never appears here.
 */
export function nextAfter(step: Step): ToolName[] {
	return LEGAL_TOOLS[step].filter((t) => t !== "workflow_status");
}

/**
 * Single source of truth for dispatch kinds — the Pi tool param schema
 * (`extension/index.ts`), the `state.json` codec (`schema/state.ts`) and the
 * `/apnea dispatch` completion list all derive from this tuple.
 */
export const DISPATCH_KINDS = [
	"plan",
	"plan_review",
	"phase_package",
	"code",
	"code_review",
	"pr_description",
] as const;

export type DispatchKind = (typeof DISPATCH_KINDS)[number];

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

/**
 * Policy check: is `tool` legal at `step`?
 * Returns Result.fail(IllegalTool) instead of throwing (no Object.assign cast).
 */
export function toolAllowed(
	step: Step,
	tool: ToolName,
): Result.Result<void, IllegalTool> {
	const legal = LEGAL_TOOLS[step];
	if (!legal.includes(tool as (typeof legal)[number])) {
		return Result.fail(
			new IllegalTool({
				step,
				tool,
				legal: [...legal],
			}),
		);
	}
	return Result.succeed(undefined);
}
