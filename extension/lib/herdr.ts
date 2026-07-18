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

/** Prefer right on wide panes, down on tall/narrow ones. */
function splitDirection(): "right" | "down" {
	const current = process.env.HERDR_PANE_ID;
	if (!current) return "right";
	const r = herdr(["pane", "layout", "--pane", current]);
	const res = resultOf(r.json);
	const layout = res?.layout as Record<string, unknown> | undefined;
	const panes = (layout?.panes as Array<Record<string, unknown>>) ?? [];
	const me = panes.find((p) => String(p.pane_id) === current);
	const rect = me?.rect as { width?: number; height?: number } | undefined;
	if (rect?.width != null && rect?.height != null) {
		return rect.width >= rect.height ? "right" : "down";
	}
	return "right";
}

export function splitPane(): string {
	const direction = splitDirection();
	const r = herdr([
		"pane",
		"split",
		"--current",
		"--direction",
		direction,
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

/** Unique per dispatch so we never collide with or claim another pane. */
export function roleLabel(role: string, dispatchId?: string): string {
	const id =
		dispatchId ??
		`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	return `apnea:${role}:${id}`;
}

/**
 * Always create a brand-new pane for this dispatch.
 * Never reuses or renames an existing labeled pane.
 */
export function createRolePane(
	role: string,
	opts?: { interactiveCmd?: string[]; dispatchId?: string },
): { pane_id: string; label: string } {
	if (!herdrEnabled()) {
		throw new Error("not inside Herdr (HERDR_ENV!=1); cannot manage panes");
	}
	const label = roleLabel(role, opts?.dispatchId);
	const paneId = splitPane();
	renamePane(paneId, label);
	if (opts?.interactiveCmd?.length) {
		const cmd = shellJoin([
			"cd",
			process.cwd(),
			"&&",
			...opts.interactiveCmd,
		]);
		paneRun(paneId, cmd);
	}
	return { pane_id: paneId, label };
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

/** Write a oneshot runner script and execute it in a fresh role pane. */
export function runOneshotInPane(
	role: string,
	cmd: string[],
	taskFileAbs: string,
): { pane_id: string; label: string; script: string } {
	const { pane_id, label } = createRolePane(role);
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
	paneRun(pane_id, script);
	return { pane_id, label, script };
}

/**
 * Fresh interactive pane every dispatch (no reuse).
 * Waits until agent is idle/done before sending the prompt.
 */
export function runInteractivePrompt(
	role: string,
	interactiveCmd: string[],
	prompt: string,
): { pane_id: string; label: string } {
	const { pane_id, label } = createRolePane(role, {
		interactiveCmd,
	});
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		const s = paneGet(pane_id).agent_status;
		if (s === "idle" || s === "done") break;
		// still starting
		spawnSync("sleep", ["1"]);
	}
	const ready = paneGet(pane_id).agent_status;
	if (ready !== "idle" && ready !== "done") {
		// still send — agent may accept input; surface status via return path
	}
	paneRun(pane_id, prompt);
	return { pane_id, label };
}

export function sleepMs(ms: number): void {
	spawnSync("sleep", [String(ms / 1000)]);
}
