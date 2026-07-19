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
	ok: boolean;
	agent_status?: string;
	label?: string;
} {
	const r = herdr(["pane", "get", paneId]);
	if (!r.ok) return { ok: false };
	const res = resultOf(r.json);
	const pane = (res?.pane as Record<string, unknown>) ?? {};
	// if herdr returned ok but no pane, treat as missing
	if (!pane.pane_id && !pane.agent_status && !pane.label) {
		// some responses still nest pane
	}
	return {
		ok: true,
		agent_status: pane.agent_status ? String(pane.agent_status) : undefined,
		label: pane.label ? String(pane.label) : undefined,
	};
}

/** True if Herdr still knows this pane id. */
export function paneAlive(paneId: string): boolean {
	const info = paneGet(paneId);
	return info.ok;
}

/** Unique label for a role slot (stable for the run when we reuse the pane). */
export function roleLabel(role: string, slotId?: string): string {
	const id =
		slotId ??
		`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	return `apnea:${role}:${id}`;
}

export type RolePaneRef = { pane_id: string; label: string };

/**
 * Resolve a pane for a role:
 * - reuse `prefer` if that pane_id is still alive
 * - otherwise split a new pane with a unique label
 *
 * Never claims an unrelated pane by scanning labels alone.
 */
export function acquireRolePane(
	role: string,
	opts?: {
		prefer?: RolePaneRef | null;
		interactiveCmd?: string[];
	},
): RolePaneRef & { reused: boolean } {
	if (!herdrEnabled()) {
		throw new Error("not inside Herdr (HERDR_ENV!=1); cannot manage panes");
	}

	if (opts?.prefer?.pane_id && paneAlive(opts.prefer.pane_id)) {
		return {
			pane_id: opts.prefer.pane_id,
			label: opts.prefer.label,
			reused: true,
		};
	}

	const label = roleLabel(role);
	const paneId = splitPane();
	renamePane(paneId, label);
	if (opts?.interactiveCmd?.length) {
		const cmd = shellJoin(["cd", process.cwd(), "&&", ...opts.interactiveCmd]);
		paneRun(paneId, cmd);
	}
	return { pane_id: paneId, label, reused: false };
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

function waitAgentReady(
	paneId: string,
	timeoutMs = 90_000,
): string | undefined {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const s = paneGet(paneId).agent_status;
		if (s === "idle" || s === "done") return s;
		spawnSync("sleep", ["1"]);
	}
	return paneGet(paneId).agent_status;
}

/** Oneshot: reuse shell pane if we have a live pane_id; else create. Always new process. */
export function runOneshotInPane(
	role: string,
	cmd: string[],
	taskFileAbs: string,
	prefer?: RolePaneRef | null,
): { pane_id: string; label: string; script: string; reused: boolean } {
	const acquired = acquireRolePane(role, { prefer });
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
	paneRun(acquired.pane_id, script);
	return {
		pane_id: acquired.pane_id,
		label: acquired.label,
		script,
		reused: acquired.reused,
	};
}

/**
 * Interactive: reuse live pane if idle/done (follow-up prompt).
 * If missing or stuck working/blocked, spawn a new pane + agent.
 */
export function runInteractivePrompt(
	role: string,
	interactiveCmd: string[],
	prompt: string,
	prefer?: RolePaneRef | null,
): { pane_id: string; label: string; reused: boolean } {
	let preferUse: RolePaneRef | null = null;
	if (prefer?.pane_id && paneAlive(prefer.pane_id)) {
		const st = paneGet(prefer.pane_id).agent_status;
		// only reuse when agent can take a new prompt
		if (st === "idle" || st === "done" || st === "unknown") {
			preferUse = prefer;
		}
		// if working/blocked, fall through to new pane
	}

	const acquired = acquireRolePane(role, {
		prefer: preferUse,
		interactiveCmd: preferUse ? undefined : interactiveCmd,
	});

	if (!acquired.reused) {
		waitAgentReady(acquired.pane_id);
	} else {
		// ensure idle before follow-up
		const st = paneGet(acquired.pane_id).agent_status;
		if (st === "unknown") {
			// shell without agent — launch interactive cmd
			paneRun(
				acquired.pane_id,
				shellJoin(["cd", process.cwd(), "&&", ...interactiveCmd]),
			);
			waitAgentReady(acquired.pane_id);
		} else if (st !== "idle" && st !== "done") {
			// shouldn't happen given preferUse filter; wait briefly
			waitAgentReady(acquired.pane_id, 30_000);
		}
	}

	paneRun(acquired.pane_id, prompt);
	return {
		pane_id: acquired.pane_id,
		label: acquired.label,
		reused: acquired.reused,
	};
}

export function sleepMs(ms: number): void {
	spawnSync("sleep", [String(ms / 1000)]);
}
