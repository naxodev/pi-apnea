import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type { PaneStyle, Role } from "./types.ts";

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

/**
 * Send text + Enter into a pane.
 * When a live agent TUI is focused, this submits a prompt (not a shell command).
 * When the pane is a bare shell, this runs a shell line.
 */
export function paneRun(paneId: string, command: string): void {
	const r = herdr(["pane", "run", paneId, command]);
	if (!r.ok) throw new Error(`herdr pane run failed: ${r.raw}`);
}

/** Send raw key names (e.g. Escape, Enter) into a pane. */
export function paneSendKeys(paneId: string, keys: string[]): void {
	if (keys.length === 0) return;
	const r = herdr(["pane", "send-keys", paneId, ...keys]);
	if (!r.ok) throw new Error(`herdr pane send-keys failed: ${r.raw}`);
}

/**
 * After submitting a prompt, confirm the agent actually started working.
 * Claude often parks multi-line paste in the input without submitting;
 * pi+vim can leave the prompt in INSERT mode. Recover with Enter (then
 * one full re-submit) before giving up.
 */
export function ensurePromptSubmitted(
	paneId: string,
	prompt: string,
	opts?: { settleMs?: number; workingWaitMs?: number },
): { accepted: boolean; attempts: number; last_status?: string } {
	const settleMs = opts?.settleMs ?? 2500;
	const workingWaitMs = opts?.workingWaitMs ?? 12_000;
	let attempts = 1;

	const waitForWorking = (ms: number): string | undefined => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const s = paneGet(paneId).agent_status;
			if (s === "working" || s === "blocked") return s;
			sleepMs(400);
		}
		return paneGet(paneId).agent_status;
	};

	// Give the first paneRun a moment to flip status.
	sleepMs(settleMs);
	let status = waitForWorking(workingWaitMs);
	if (status === "working" || status === "blocked") {
		return { accepted: true, attempts, last_status: status };
	}

	// Paste often lands without submit — Enter alone recovers Claude.
	attempts += 1;
	try {
		paneSendKeys(paneId, ["Enter"]);
	} catch {
		/* pane may have died */
	}
	status = waitForWorking(workingWaitMs);
	if (status === "working" || status === "blocked") {
		return { accepted: true, attempts, last_status: status };
	}

	// Full re-submit once (covers lost/mangled first paste).
	attempts += 1;
	try {
		paneRun(paneId, prompt);
	} catch {
		return { accepted: false, attempts, last_status: paneGet(paneId).agent_status };
	}
	sleepMs(settleMs);
	status = waitForWorking(workingWaitMs);
	return {
		accepted: status === "working" || status === "blocked",
		attempts,
		last_status: status,
	};
}

export function paneGet(paneId: string): {
	ok: boolean;
	agent_status?: string;
	label?: string;
	agent?: string;
} {
	const r = herdr(["pane", "get", paneId]);
	if (!r.ok) return { ok: false };
	const res = resultOf(r.json);
	const pane = (res?.pane as Record<string, unknown>) ?? {};
	return {
		ok: true,
		agent_status: pane.agent_status ? String(pane.agent_status) : undefined,
		label: pane.label ? String(pane.label) : undefined,
		agent: pane.agent ? String(pane.agent) : undefined,
	};
}

/** True if Herdr still knows this pane id. */
export function paneAlive(paneId: string): boolean {
	const info = paneGet(paneId);
	return info.ok;
}

/**
 * Wait until agent reports idle or done (ready for a prompt).
 * Uses herdr wait when available; falls back to poll.
 */
export function waitAgentReady(
	paneId: string,
	timeoutMs = 90_000,
): string | undefined {
	// Prefer Herdr's blocking wait (does not freeze our caller if we use it
	// only for short readiness; dispatch is already a tool call).
	const r = herdr([
		"wait",
		"agent-status",
		paneId,
		"--status",
		"idle",
		"--timeout",
		String(timeoutMs),
	]);
	if (r.ok) {
		const s = paneGet(paneId).agent_status;
		if (s === "idle" || s === "done") return s;
	}
	// fall back: poll (done also counts as ready)
	const deadline = Date.now() + Math.min(timeoutMs, 30_000);
	while (Date.now() < deadline) {
		const s = paneGet(paneId).agent_status;
		if (s === "idle" || s === "done") return s;
		spawnSync("sleep", ["0.5"]);
	}
	return paneGet(paneId).agent_status;
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
		/** Launch interactive harness only when creating a new pane */
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
		// Launch the interactive harness only (no task argv).
		// cwd: herdr split inherits; also cd then exec so profile is in project.
		const cmd = shellJoin([
			"cd",
			process.cwd(),
			"&&",
			"exec",
			...opts.interactiveCmd,
		]);
		paneRun(paneId, cmd);
	}
	return { pane_id: paneId, label, reused: false };
}

export function shellJoin(parts: string[]): string {
	return parts
		.map((p) => {
			if (p === "&&" || p === "|" || p === "exec") return p;
			if (/^[A-Za-z0-9_./:=,@+-]+$/.test(p)) return p;
			return `'${p.replace(/'/g, `'\\''`)}'`;
		})
		.join(" ");
}

/**
 * Open the interactive harness TUI in a pane (or reuse), wait until idle,
 * then submit a short pointer prompt via `pane run` (text + Enter).
 *
 * This is the Herdr-recommended path: live agent you can watch, not
 * `claude -p` / `pi -p` dumping shell output.
 */
export function runInteractivePrompt(
	role: string,
	interactiveCmd: string[],
	prompt: string,
	prefer?: RolePaneRef | null,
): {
	pane_id: string;
	label: string;
	reused: boolean;
	prompt_accepted: boolean;
	prompt_attempts: number;
	last_status?: string;
} {
	let preferUse: RolePaneRef | null = null;
	if (prefer?.pane_id && paneAlive(prefer.pane_id)) {
		const info = paneGet(prefer.pane_id);
		const st = info.agent_status;
		// reuse only when a live agent can take a new prompt
		if (st === "idle" || st === "done") {
			preferUse = prefer;
		}
		// working/blocked/unknown/shell-only → new pane
	}

	const acquired = acquireRolePane(role, {
		prefer: preferUse,
		interactiveCmd: preferUse ? undefined : interactiveCmd,
	});

	if (!acquired.reused) {
		const ready = waitAgentReady(acquired.pane_id, 90_000);
		if (ready !== "idle" && ready !== "done") {
			// still try — some harnesses accept input before status settles
		}
	} else {
		const st = paneGet(acquired.pane_id).agent_status;
		if (st !== "idle" && st !== "done") {
			waitAgentReady(acquired.pane_id, 30_000);
		}
	}

	// Submit pointer into the live TUI (Herdr: pane run = text + Enter),
	// then confirm the agent actually started — do not trust fire-and-forget.
	paneRun(acquired.pane_id, prompt);
	const submit = ensurePromptSubmitted(acquired.pane_id, prompt);
	return {
		pane_id: acquired.pane_id,
		label: acquired.label,
		reused: acquired.reused,
		prompt_accepted: submit.accepted,
		prompt_attempts: submit.attempts,
		last_status: submit.last_status,
	};
}

/** Parse `herdr X.Y.Z` (or noisy multi-line) into a numeric tuple. */
export function parseHerdrVersion(
	raw: string,
): [number, number, number] | null {
	const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function versionGte(
	a: [number, number, number],
	b: [number, number, number],
): boolean {
	const [a0, a1, a2] = a;
	const [b0, b1, b2] = b;
	if (a0 !== b0) return a0 > b0;
	if (a1 !== b1) return a1 > b1;
	return a2 >= b2;
}

/** Run `herdr --version` (plain text, not JSON). */
export function herdrVersion(): [number, number, number] | null {
	const r = herdr(["--version"]);
	return parseHerdrVersion(r.raw);
}

/**
 * Floating popups need herdr ≥ 0.7.4. Fail closed on unparseable versions so an
 * unattended run never hangs on a CLI that rejects `--placement popup`.
 */
export function supportsFloating(
	version: [number, number, number] | null = herdrVersion(),
): boolean {
	return version != null && versionGte(version, [0, 7, 4]);
}

/** True iff the linked `apnea` herdr plugin is present. */
export function hasApneaPlugin(): boolean {
	const r = herdr(["plugin", "list", "--plugin", "apnea", "--json"]);
	const json = r.json;
	if (json) {
		const res = resultOf(json);
		const plugins = (res?.plugins as Array<Record<string, unknown>>) ?? [];
		if (
			plugins.some(
				(p) =>
					p.plugin_id === "apnea" || p.id === "apnea" || p.name === "Apnea",
			)
		) {
			return true;
		}
	}
	// Fallback when JSON shape is unexpected but the id still appears in output.
	return /"(?:plugin_id|id)"\s*:\s*"apnea"/.test(r.raw);
}

/** Write a self-contained bash script that cds to root and execs cmd + prompt. */
export function writeFloatingTaskScript(
	scriptAbs: string,
	root: string,
	cmd: string[],
	prompt: string,
): void {
	const body = [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		shellJoin(["cd", root]),
		shellJoin(["exec", ...cmd, prompt]),
		"",
	].join("\n");
	fs.writeFileSync(scriptAbs, body, "utf8");
	fs.chmodSync(scriptAbs, 0o755);
}

/** Open the apnea worker popup; popups have no pane id. */
export function openFloatingPane(taskScriptAbs: string, root: string): void {
	const r = herdr([
		"plugin",
		"pane",
		"open",
		"--plugin",
		"apnea",
		"--entrypoint",
		"worker",
		"--placement",
		"popup",
		"--cwd",
		root,
		"--env",
		`APNEA_TASK_SCRIPT=${taskScriptAbs}`,
	]);
	if (!r.ok) throw new Error(`herdr plugin pane open failed: ${r.raw}`);
}

/**
 * Configured style vs effective style. Floating is only for planner/reviewer
 * (oneshot-eligible artifact producers); interactive roles always stay regular.
 */
export function effectivePaneStyle(
	configured: PaneStyle,
	role: Role,
): { style: PaneStyle; effective: string } {
	if (configured === "regular") {
		return { style: "regular", effective: "regular" };
	}
	if (role === "planner" || role === "reviewer") {
		return { style: "floating", effective: "floating" };
	}
	return { style: "regular", effective: "regular (interactive role)" };
}

export function sleepMs(ms: number): void {
	spawnSync("sleep", [String(ms / 1000)]);
}
