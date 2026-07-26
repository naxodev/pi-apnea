import type { ToolResult } from "../result.ts";
import { runToolResult } from "../run-tool.ts";
import { AppLive } from "../services/app-live.ts";
import { resolveExecutable } from "../services/herdr.ts";
import { materializePiRoleAgentDir } from "../services/pi-role-agent.ts";
import { setupWorkflow, type SetupDeps, type SetupParams } from "../workflows/setup.ts";

/**
 * Walk PATH directly rather than spawning `which` once per binary — `which`
 * itself is absent from minimal environments, which would report every
 * harness as missing.
 */
function onPath(bin: string): boolean {
	return resolveExecutable(bin) !== null;
}

const prodDeps: SetupDeps = {
	onPath,
	materializeRoleAgentDir: () => materializePiRoleAgentDir(),
};

export async function apneaSetup(params: SetupParams): Promise<ToolResult> {
	return runToolResult(setupWorkflow(params, process.cwd(), prodDeps), AppLive);
}
