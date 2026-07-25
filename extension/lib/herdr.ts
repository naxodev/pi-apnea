import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	effectivePaneStyle,
	floatingTaskScriptBody,
	parseHerdrVersion,
	shellJoin,
	supportsFloating as domainSupportsFloating,
	versionGte,
} from "../domain/herdr.ts";
import { isPiCmd, wrapInteractiveCmdNoVim } from "../services/pi-role-agent.ts";

export {
	effectivePaneStyle,
	parseHerdrVersion,
	shellJoin,
	versionGte,
};

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
 * pi+vim can leave the prompt in INSERT mode. Recover with Escape+Enter
 * (then one full re-submit) before giving up.
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

	// Paste often lands without submit — Enter alone recovers Claude;
	// Escape first exits pi-vim INSERT so Enter can actually submit.
	attempts += 1;
	try {
		paneSendKeys(paneId, ["Escape"]);
		sleepMs(150);
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
		paneSendKeys(paneId, ["Escape"]);
		sleepMs(100);
		paneRun(paneId, prompt);
	} catch {
		return {
			accepted: false,
			attempts,
			last_status: paneGet(paneId).agent_status,
		};
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
		// Pi roles get PI_CODING_AGENT_DIR without pi-vimmode so pane-run pastes
		// are not trapped in modal INSERT.
		const launchCmd = wrapInteractiveCmdNoVim(opts.interactiveCmd);
		const cmd = shellJoin(["cd", process.cwd(), "&&", "exec", ...launchCmd]);
		paneRun(paneId, cmd);
	}
	return { pane_id: paneId, label, reused: false };
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

	// Reused pi panes (or any pi that still has vimmode) — slash-disable
	// before the task pointer so herdr paste submits as a normal prompt.
	if (isPiCmd(interactiveCmd)) {
		try {
			paneRun(acquired.pane_id, "/vimmode off");
			waitAgentReady(acquired.pane_id, 5_000);
			sleepMs(300);
		} catch {
			/* best-effort; no-vim agent dir is the primary guard */
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
	return domainSupportsFloating(version);
}

/** True iff the linked `apnea` herdr plugin is present. */
export function hasApneaPlugin(): boolean {
	const r = herdr(["plugin", "list", "--plugin", "apnea", "--json"]);
	const json = r.json;
	if (json) {
		const res = resultOf(json);
		const plugins = (res?.plugins as Array<Record<string, unknown>>) ?? [];
		if (plugins.some((p) => p.plugin_id === "apnea" || p.id === "apnea")) {
			return true;
		}
	}
	// Fallback when JSON shape is unexpected but the id still appears in output.
	return /"(?:plugin_id|id)"\s*:\s*"apnea"/.test(r.raw);
}

function isExecutableFile(abs: string): boolean {
	try {
		fs.accessSync(abs, fs.constants.X_OK);
		return fs.statSync(abs).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolve a oneshot binary against the orchestrator environment.
 * Floating plugin popups get a stripped PATH (no ~/.local/bin etc.), so bare
 * names like `claude` exit 127 unless we bake an absolute path into the script.
 * Walks PATH directly — no `which` subprocess (which itself vanishes when PATH
 * is overridden for tests or minimal envs).
 */
export function resolveExecutable(
	bin: string,
	envPath: string | undefined = process.env.PATH,
): string | null {
	if (!bin) return null;
	if (bin.includes("/") || bin.includes("\\")) {
		const abs = path.isAbsolute(bin) ? bin : path.resolve(bin);
		return isExecutableFile(abs) ? abs : null;
	}
	for (const dir of (envPath ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, bin);
		if (isExecutableFile(candidate)) return candidate;
	}
	return null;
}

/**
 * PATH for floating plugin panes: orchestrator PATH plus common user-local
 * bin dirs so child tools the oneshot agent spawns still resolve.
 */
export function floatingPanePath(
	base: string = process.env.PATH ?? "",
	home: string = os.homedir(),
): string {
	const extras = [
		path.join(home, ".local", "bin"),
		path.join(home, ".bun", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	];
	const parts = base.split(path.delimiter).filter(Boolean);
	const seen = new Set(parts);
	for (const extra of extras) {
		if (seen.has(extra)) continue;
		try {
			if (fs.statSync(extra).isDirectory()) {
				parts.push(extra);
				seen.add(extra);
			}
		} catch {
			// skip missing dirs
		}
	}
	return parts.join(path.delimiter);
}

/** Write a self-contained bash script that cds to root and execs cmd + prompt. */
/** Read exit code written by a floating task script; null if not finished. */
export function readFloatingExit(exitFileAbs: string): number | null {
	if (!fs.existsSync(exitFileAbs)) return null;
	try {
		const t = fs.readFileSync(exitFileAbs, "utf8").trim();
		const n = Number.parseInt(t, 10);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

/**
 * Write a self-contained bash script that cds to root, runs cmd + prompt as a
 * child (not exec — so EXIT trap still fires), and always records the exit
 * code for workflow_wait. Popups have no pane id; the exit file is the liveness
 * signal.
 */
export function writeFloatingTaskScript(
	scriptAbs: string,
	root: string,
	cmd: string[],
	prompt: string,
	exitFileAbs: string,
): void {
	if (cmd.length === 0) {
		throw new Error(
			"floating oneshot cmd is empty; set cmd_oneshot on the role profile",
		);
	}
	const bin = cmd[0];
	if (bin === undefined || bin === "") {
		throw new Error(
			"floating oneshot binary is empty; set cmd_oneshot on the role profile",
		);
	}
	const resolved = resolveExecutable(bin);
	if (!resolved) {
		throw new Error(
			`floating oneshot binary "${bin}" not found on PATH; use an absolute cmd_oneshot or set pane_style=regular`,
		);
	}
	const resolvedCmd = [resolved, ...cmd.slice(1)];
	// No `exec`: EXIT trap must run after the oneshot exits (Hangup included).
	// End-of-options `--` before the prompt so variadic flags like Claude's
	// `--allowedTools <tools...>` cannot swallow the prompt as another tool.
	const body = floatingTaskScriptBody({ root, resolvedCmd, prompt, exitFileAbs });
	fs.writeFileSync(scriptAbs, body, "utf8");
	fs.chmodSync(scriptAbs, 0o755);
}

/**
 * Open the apnea worker popup; popups have no pane id.
 * Intentionally omits `--cwd`: herdr resolves the plugin's relative
 * `scripts/run-task.sh` against that cwd (not plugin_root), which 127s when
 * pointed at the project. The task script itself `cd`s to the project root.
 */
export function openFloatingPane(taskScriptAbs: string, _root: string): void {
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
		"--env",
		`APNEA_TASK_SCRIPT=${taskScriptAbs}`,
		"--env",
		`PATH=${floatingPanePath()}`,
	]);
	if (!r.ok) {
		const raw = r.raw.trim();
		if (/popup already open/i.test(raw)) {
			throw new Error(
				"floating popup already open — herdr allows only one; dismiss it or workflow_wait for the in-flight oneshot before dispatching again",
			);
		}
		throw new Error(`herdr plugin pane open failed: ${raw || r.raw}`);
	}
}

export function sleepMs(ms: number): void {
	spawnSync("sleep", [String(ms / 1000)]);
}
