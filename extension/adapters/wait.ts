import type { ToolResult } from "../result.ts";
import { runToolResult } from "../run-tool.ts";
import { AppLive } from "../services/app-live.ts";
import {
	waitWorkflow,
	type WaitHooks,
	type WaitParams,
} from "../workflows/wait.ts";

export async function workflowWait(
	params: WaitParams,
	hooks: WaitHooks = {},
): Promise<ToolResult> {
	return runToolResult(waitWorkflow(params, process.cwd(), hooks), AppLive);
}
