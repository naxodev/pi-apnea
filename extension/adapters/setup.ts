import { spawnSync } from "node:child_process";
import type { ToolResult } from "../result.ts";
import { runToolResult } from "../run-tool.ts";
import { AppLive } from "../services/app-live.ts";
import { materializePiRoleAgentDir } from "../services/pi-role-agent.ts";
import { setupWorkflow, type SetupDeps, type SetupParams } from "../workflows/setup.ts";

function onPath(bin: string): boolean {
	const r = spawnSync("which", [bin], { encoding: "utf8" });
	return r.status === 0 && Boolean(r.stdout?.trim());
}

const prodDeps: SetupDeps = {
	onPath,
	materializeRoleAgentDir: () => materializePiRoleAgentDir(),
};

export async function apneaSetup(params: SetupParams): Promise<ToolResult> {
	return runToolResult(setupWorkflow(params, process.cwd(), prodDeps), AppLive);
}
