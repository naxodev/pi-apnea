import { AppLive } from "../services/app-live.ts";
import type { ToolResult } from "../result.ts";
import { runToolResult } from "../run-tool.ts";
import { resetRoundsWorkflow } from "../workflows/reset.ts";
import { statusWorkflow } from "../workflows/status.ts";

export async function workflowStatus(): Promise<ToolResult> {
	return runToolResult(statusWorkflow(process.cwd()), AppLive);
}

export async function workflowResetRounds(params: {
	gate: string;
}): Promise<ToolResult> {
	return runToolResult(resetRoundsWorkflow(params, process.cwd()), AppLive);
}
