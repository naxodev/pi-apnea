import type { ToolResult } from "../result.ts";
import { runToolResult } from "../run-tool.ts";
import { AppLive } from "../services/app-live.ts";
import { commitWorkflow, type CommitParams } from "../workflows/commit.ts";

export async function workflowCommitPhase(
	params: CommitParams,
): Promise<ToolResult> {
	return runToolResult(commitWorkflow(params, process.cwd()), AppLive);
}
