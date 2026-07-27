import type { ToolResult } from "../result.ts";
import { runToolResult } from "../run-tool.ts";
import { AppLive } from "../services/app-live.ts";
import { dispatchWorkflow, type DispatchParams } from "../workflows/dispatch.ts";

export async function workflowDispatch(
	params: DispatchParams,
): Promise<ToolResult> {
	return runToolResult(dispatchWorkflow(params, process.cwd()), AppLive);
}
