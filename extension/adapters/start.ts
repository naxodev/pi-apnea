import { AppLive } from "../services/app-live.ts";
import type { ToolResult } from "../result.ts";
import { runToolResult } from "../run-tool.ts";
import { startWorkflow, type StartParams } from "../workflows/start.ts";

export async function workflowStart(params: StartParams): Promise<ToolResult> {
	return runToolResult(startWorkflow(params, process.cwd()), AppLive);
}
