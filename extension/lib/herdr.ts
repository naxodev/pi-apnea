import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function herdrEnabled(): boolean {
	return process.env.HERDR_ENV === "1";
}

function herdr(args: string[]): { ok: boolean; json: unknown; raw: string } {
	const r = spawnSync("herdr", args, {
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});
	const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	if (r.status !== 0) {
		return { ok: false, json: null, raw };
	}
	// herdr often prints one JSON object
	const line = (r.stdout ?? "").trim().split(/\n/).filter(Boolean).pop() ?? "";
	try {
		return { ok: true, json: JSON.parse(line), raw };
	} catch {
		return { ok: true, json: null, raw };
	}
}

function resultOf(json: unknown): Record<string, unknown> | null {
	if (!json || typeof json !== "object") return null;
	const o = json as Record<string, unknown>;
	if (o.result && typeof o.result === "object")
		return o.result as Record<string, unknown>;
	return o;
}

export function listPanes(): Array<{
	pane_id: string;
	label?: string;
	agent_status?: string;
}> {
	const r = herdr([
		"pane",
		"list",
		"--workspace",
		process.env.HERDR_WORKSPACE_ID || "",
	]);
	const res = resultOf(r.json);
	const panes = (res?.panes as Array<Record<string, unknown>>) ?? [];
	return panes.map((p) => ({
		pane_id: String(p.pane_id),
		label: p.label ? String(p.label) : undefined,
		agent_status: p.agent_status ? String(p.agent_status) : undefined,
	}));
}

export function findPaneByLabel(label: string): string | null {
	const panes = listPanes();
	const hit = panes.find((p) => p.label === label);
	return hit?.pane_id ?? null;
}

export function splitPane(): string {
	const r = herdr([
		"pane",
		"split",
		"--current",
		"--direction",
		"right",
		"--no-focus",
	]);
	if (!r.ok) throw new Error(`herdr pane split failed: ${r.raw}`);
	const res = resultOf(r.json);
	const pane = res?.pane as Record<string, unknown> | undefined;
	const id = pane?.pane_id ? String(pane.pane_id) : null;
	if (!id) throw new Error(`herdr pane split: no pane_id in ${r.raw}`);
	return id;
}

export function renamePane(paneId: string, label: string): void {
	const r = herdr(["pane", "rename", paneId, label]);
	if (!r.ok) throw new Error(`herdr pane rename failed: ${r.raw}`);
}

export function paneRun(paneId: string, command: string): void {
	const r = herdr(["pane", "run", paneId, command]);
	if (!r.ok) throw new Error(`herdr pane run failed: ${r.raw}`);
}

export function paneGet(paneId: string): {
	agent_status?: string;
	label?: string;
} {
	const r = herdr(["pane", "get", paneId]);
	const res = resultOf(r.json);
	const pane = (res?.pane as Record<string, unknown>) ?? {};
	return {
		agent_status: pane.agent_status ? String(pane.agent_status) : undefined,
		label: pane.label ? String(pane.label) : undefined,
	};
}

export function roleLabel(role: string): string {
	return `apnea:${role}`;
}

/**
 * Ensure a labeled pane exists. For oneshot roles we keep a shell pane;
 * for interactive we launch the interactive cmd if pane missing or unknown.
 */
export function ensureRolePane(
	role: string,
	interactiveCmd?: string[],
): string {
	if (!herdrEnabled()) {
		throw new Error("not inside Herdr (HERDR_ENV!=1); cannot manage panes");
	}
	const label = roleLabel(role);
	let id = findPaneByLabel(label);
	if (!id) {
		id = splitPane();
		renamePane(id, label);
		if (interactiveCmd?.length) {
			// cd to project then launch
			const cmd = shellJoin(["cd", process.cwd(), "&&", ...interactiveCmd]);
			paneRun(id, cmd);
		}
	}
	return id;
}

export function shellJoin(parts: string[]): string {
	return parts
		.map((p) => {
			if (p === "&&" || p === "|") return p;
			if (/^[A-Za-z0-9_./:=,@+-]+$/.test(p)) return p;
			return `'${p.replace(/'/g, `'\\''`)}'`;
		})
		.join(" ");
}

/** Write a oneshot runner script and execute it in the role pane. */
export function runOneshotInPane(
	role: string,
	cmd: string[],
	taskFileAbs: string,
): { pane_id: string; script: string } {
	const paneId = ensureRolePane(role);
	const scriptsDir = path.join(process.cwd(), ".apnea", "tasks");
	fs.mkdirSync(scriptsDir, { recursive: true });
	const script = path.join(scriptsDir, `run-${role}-${Date.now()}.sh`);
	const cmdStr = shellJoin(cmd);
	const body = `#!/usr/bin/env bash
set -euo pipefail
cd ${shellJoin([process.cwd()])}
# stdin = task file so markdown never breaks argv
exec ${cmdStr} < ${shellJoin([taskFileAbs])}
`;
	fs.writeFileSync(script, body, { mode: 0o755 });
	paneRun(paneId, script);
	return { pane_id: paneId, script };
}

export function runInteractivePrompt(
	role: string,
	interactiveCmd: string[],
	prompt: string,
): string {
	const paneId = ensureRolePane(role, interactiveCmd);
	// If pane exists but agent dead, relaunch
	const info = paneGet(paneId);
	if (!info.agent_status || info.agent_status === "unknown") {
		paneRun(paneId, shellJoin(["cd", process.cwd(), "&&", ...interactiveCmd]));
		// brief wait for idle
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const s = paneGet(paneId).agent_status;
			if (s === "idle" || s === "done") break;
			spawnSync("sleep", ["1"]);
		}
	}
	paneRun(paneId, prompt);
	return paneId;
}

export function sleepMs(ms: number): void {
	spawnSync("sleep", [String(ms / 1000)]);
}
