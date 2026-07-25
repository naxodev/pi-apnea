import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Clock, Context, Effect, Layer, Option } from "effect";
import {
	floatingTaskScriptBody,
	parseHerdrVersion,
	shellJoin,
} from "../domain/herdr.ts";
import { HerdrError } from "../errors.ts";
import { isPiCmd, wrapInteractiveCmdNoVim } from "./pi-role-agent.ts";

export type PaneInfo = {
	ok: boolean;
	agent_status?: string;
	label?: string;
	agent?: string;
};
export type RolePaneRef = { pane_id: string; label: string };
export type InteractiveLaunch = {
	pane_id: string;
	label: string;
	reused: boolean;
	prompt_accepted: boolean;
	prompt_attempts: number;
	last_status?: string;
};

export interface HerdrService {
	readonly enabled: Effect.Effect<boolean>;
	readonly version: Effect.Effect<[number, number, number] | null>;
	readonly hasApneaPlugin: Effect.Effect<boolean>;
	readonly paneGet: (paneId: string) => Effect.Effect<PaneInfo>;
	readonly paneRun: (
		paneId: string,
		command: string,
	) => Effect.Effect<void, HerdrError>;
	readonly paneForegroundNames: (paneId: string) => Effect.Effect<string[]>;
	readonly runInteractivePrompt: (
		role: string,
		interactiveCmd: string[],
		prompt: string,
		prefer: RolePaneRef | null,
	) => Effect.Effect<InteractiveLaunch, HerdrError>;
	readonly writeFloatingTaskScript: (
		scriptAbs: string,
		root: string,
		cmd: string[],
		prompt: string,
		exitFileAbs: string,
	) => Effect.Effect<void, HerdrError>;
	readonly openFloatingPane: (
		taskScriptAbs: string,
		root: string,
	) => Effect.Effect<void, HerdrError>;
	readonly linkPlugin: (dir: string) => Effect.Effect<{ ok: boolean; raw: string }>;
}

export class Herdr extends Context.Service<Herdr, HerdrService>()(
	"apnea/Herdr",
) {}

function herdrCli(args: string[]): { ok: boolean; json: unknown; raw: string } {
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

function herdrEnabledSync(): boolean {
	return process.env.HERDR_ENV === "1";
}

function paneGetSync(paneId: string): PaneInfo {
	const r = herdrCli(["pane", "get", paneId]);
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

function paneAliveSync(paneId: string): boolean {
	return paneGetSync(paneId).ok;
}

/** Prefer right on wide panes, down on tall/narrow ones. */
function splitDirectionSync(): "right" | "down" {
	const current = process.env.HERDR_PANE_ID;
	if (!current) return "right";
	const r = herdrCli(["pane", "layout", "--pane", current]);
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

function splitPaneSync(): string {
	const direction = splitDirectionSync();
	const r = herdrCli([
		"pane",
		"split",
		"--current",
		"--direction",
		direction,
		"--no-focus",
	]);
	if (!r.ok) throw new HerdrError({ message: `herdr pane split failed: ${r.raw}` });
	const res = resultOf(r.json);
	const pane = res?.pane as Record<string, unknown> | undefined;
	const id = pane?.pane_id ? String(pane.pane_id) : null;
	if (!id) {
		throw new HerdrError({ message: `herdr pane split: no pane_id in ${r.raw}` });
	}
	return id;
}

function renamePaneSync(paneId: string, label: string): void {
	const r = herdrCli(["pane", "rename", paneId, label]);
	if (!r.ok) {
		throw new HerdrError({ message: `herdr pane rename failed: ${r.raw}` });
	}
}

/**
 * Send text + Enter into a pane.
 * When a live agent TUI is focused, this submits a prompt (not a shell command).
 * When the pane is a bare shell, this runs a shell line.
 */
function paneRunSync(paneId: string, command: string): void {
	const r = herdrCli(["pane", "run", paneId, command]);
	if (!r.ok) {
		throw new HerdrError({
			message: `herdr pane run failed: ${r.raw}`,
			command: "herdr pane run",
		});
	}
}

/** Send raw key names (e.g. Escape, Enter) into a pane. */
function paneSendKeysSync(paneId: string, keys: string[]): void {
	if (keys.length === 0) return;
	const r = herdrCli(["pane", "send-keys", paneId, ...keys]);
	if (!r.ok) {
		throw new HerdrError({ message: `herdr pane send-keys failed: ${r.raw}` });
	}
}

function herdrVersionSync(): [number, number, number] | null {
	return parseHerdrVersion(herdrCli(["--version"]).raw);
}

function hasApneaPluginSync(): boolean {
	const r = herdrCli(["plugin", "list", "--plugin", "apnea", "--json"]);
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

function paneForegroundNamesSync(paneId: string): string[] {
	try {
		const r = spawnSync("herdr", ["pane", "process-info", "--pane", paneId], {
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		});
		if (r.status !== 0) return [];
		const line =
			(r.stdout ?? "").trim().split(/\n/).filter(Boolean).pop() ?? "";
		const json = JSON.parse(line) as {
			result?: {
				process_info?: {
					foreground_processes?: Array<{
						name?: string;
						argv0?: string;
						cmdline?: string;
					}>;
				};
			};
		};
		const procs = json.result?.process_info?.foreground_processes ?? [];
		return procs.map((p) => p.cmdline || p.argv0 || p.name || "?");
	} catch {
		return [];
	}
}

function toHerdrError(e: unknown): HerdrError {
	return e instanceof HerdrError
		? e
		: new HerdrError({ message: e instanceof Error ? e.message : String(e) });
}

/** Unique label for a role slot (stable for the run when we reuse the pane). */
function roleLabel(role: string, millis: number): string {
	const id = `${millis.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	return `apnea:${role}:${id}`;
}

/**
 * Wait until agent reports idle or done (ready for a prompt).
 * Uses herdr wait when available; falls back to poll.
 */
function waitAgentReady(
	paneId: string,
	timeoutMs = 90_000,
): Effect.Effect<string | undefined> {
	return Effect.gen(function* () {
		// Prefer Herdr's blocking wait (does not freeze our caller if we use it
		// only for short readiness; dispatch is already a tool call).
		const r = herdrCli([
			"wait",
			"agent-status",
			paneId,
			"--status",
			"idle",
			"--timeout",
			String(timeoutMs),
		]);
		if (r.ok) {
			const s = paneGetSync(paneId).agent_status;
			if (s === "idle" || s === "done") return s;
		}
		// fall back: poll (done also counts as ready)
		const deadline = Date.now() + Math.min(timeoutMs, 30_000);
		while (Date.now() < deadline) {
			const s = paneGetSync(paneId).agent_status;
			if (s === "idle" || s === "done") return s;
			yield* Effect.sleep(500);
		}
		return paneGetSync(paneId).agent_status;
	});
}

/**
 * After submitting a prompt, confirm the agent actually started working.
 * Claude often parks multi-line paste in the input without submitting;
 * pi+vim can leave the prompt in INSERT mode. Recover with Escape+Enter
 * (then one full re-submit) before giving up.
 */
function ensurePromptSubmitted(
	paneId: string,
	prompt: string,
	opts?: { settleMs?: number; workingWaitMs?: number },
): Effect.Effect<{ accepted: boolean; attempts: number; last_status?: string }> {
	return Effect.gen(function* () {
		const settleMs = opts?.settleMs ?? 2500;
		const workingWaitMs = opts?.workingWaitMs ?? 12_000;
		let attempts = 1;

		const waitForWorking = (ms: number): Effect.Effect<string | undefined> =>
			Effect.gen(function* () {
				const deadline = Date.now() + ms;
				while (Date.now() < deadline) {
					const s = paneGetSync(paneId).agent_status;
					if (s === "working" || s === "blocked") return s;
					yield* Effect.sleep(400);
				}
				return paneGetSync(paneId).agent_status;
			});

		// Give the first paneRun a moment to flip status.
		yield* Effect.sleep(settleMs);
		let status = yield* waitForWorking(workingWaitMs);
		if (status === "working" || status === "blocked") {
			return { accepted: true, attempts, last_status: status };
		}

		// Paste often lands without submit — Enter alone recovers Claude;
		// Escape first exits pi-vim INSERT so Enter can actually submit.
		attempts += 1;
		yield* Effect.ignore(
			Effect.gen(function* () {
				paneSendKeysSync(paneId, ["Escape"]);
				yield* Effect.sleep(150);
				paneSendKeysSync(paneId, ["Enter"]);
			}),
		);
		status = yield* waitForWorking(workingWaitMs);
		if (status === "working" || status === "blocked") {
			return { accepted: true, attempts, last_status: status };
		}

		// Full re-submit once (covers lost/mangled first paste).
		attempts += 1;
		const resubmitted = yield* Effect.option(
			Effect.gen(function* () {
				paneSendKeysSync(paneId, ["Escape"]);
				yield* Effect.sleep(100);
				paneRunSync(paneId, prompt);
			}),
		);
		if (Option.isNone(resubmitted)) {
			return {
				accepted: false,
				attempts,
				last_status: paneGetSync(paneId).agent_status,
			};
		}
		yield* Effect.sleep(settleMs);
		status = yield* waitForWorking(workingWaitMs);
		return {
			accepted: status === "working" || status === "blocked",
			attempts,
			last_status: status,
		};
	});
}

/**
 * Resolve a pane for a role:
 * - reuse `prefer` if that pane_id is still alive
 * - otherwise split a new pane with a unique label
 *
 * Never claims an unrelated pane by scanning labels alone.
 */
function acquireRolePane(
	role: string,
	opts?: {
		prefer?: RolePaneRef | null;
		/** Launch interactive harness only when creating a new pane */
		interactiveCmd?: string[];
	},
): Effect.Effect<RolePaneRef & { reused: boolean }, HerdrError> {
	return Effect.gen(function* () {
		if (!herdrEnabledSync()) {
			return yield* new HerdrError({
				message: "not inside Herdr (HERDR_ENV!=1); cannot manage panes",
			});
		}

		if (opts?.prefer?.pane_id && paneAliveSync(opts.prefer.pane_id)) {
			return {
				pane_id: opts.prefer.pane_id,
				label: opts.prefer.label,
				reused: true,
			};
		}

		const millis = yield* Clock.currentTimeMillis;
		const label = roleLabel(role, millis);
		const paneId = yield* Effect.try({
			try: () => splitPaneSync(),
			catch: toHerdrError,
		});
		yield* Effect.try({
			try: () => renamePaneSync(paneId, label),
			catch: toHerdrError,
		});
		if (opts?.interactiveCmd?.length) {
			// Launch the interactive harness only (no task argv).
			// Pi roles get PI_CODING_AGENT_DIR without pi-vimmode so pane-run pastes
			// are not trapped in modal INSERT.
			const launchCmd = wrapInteractiveCmdNoVim(opts.interactiveCmd);
			const cmd = shellJoin(["cd", process.cwd(), "&&", "exec", ...launchCmd]);
			yield* Effect.try({
				try: () => paneRunSync(paneId, cmd),
				catch: toHerdrError,
			});
		}
		return { pane_id: paneId, label, reused: false };
	});
}

/**
 * Open the interactive harness TUI in a pane (or reuse), wait until idle,
 * then submit a short pointer prompt via `pane run` (text + Enter).
 *
 * This is the Herdr-recommended path: live agent you can watch, not
 * `claude -p` / `pi -p` dumping shell output.
 */
function runInteractivePromptImpl(
	role: string,
	interactiveCmd: string[],
	prompt: string,
	prefer: RolePaneRef | null,
): Effect.Effect<InteractiveLaunch, HerdrError> {
	return Effect.gen(function* () {
		let preferUse: RolePaneRef | null = null;
		if (prefer?.pane_id && paneAliveSync(prefer.pane_id)) {
			const info = paneGetSync(prefer.pane_id);
			const st = info.agent_status;
			// reuse only when a live agent can take a new prompt
			if (st === "idle" || st === "done") {
				preferUse = prefer;
			}
			// working/blocked/unknown/shell-only → new pane
		}

		const acquired = yield* acquireRolePane(role, {
			prefer: preferUse,
			interactiveCmd: preferUse ? undefined : interactiveCmd,
		});

		if (!acquired.reused) {
			yield* waitAgentReady(acquired.pane_id, 90_000);
			// still try even if not idle/done — some harnesses accept input
			// before status settles.
		} else {
			const st = paneGetSync(acquired.pane_id).agent_status;
			if (st !== "idle" && st !== "done") {
				yield* waitAgentReady(acquired.pane_id, 30_000);
			}
		}

		// Reused pi panes (or any pi that still has vimmode) — slash-disable
		// before the task pointer so herdr paste submits as a normal prompt.
		if (isPiCmd(interactiveCmd)) {
			yield* Effect.gen(function* () {
				paneRunSync(acquired.pane_id, "/vimmode off");
				yield* waitAgentReady(acquired.pane_id, 5_000);
				yield* Effect.sleep(300);
			}).pipe(Effect.ignore);
		}

		// Submit pointer into the live TUI (Herdr: pane run = text + Enter),
		// then confirm the agent actually started — do not trust fire-and-forget.
		yield* Effect.try({
			try: () => paneRunSync(acquired.pane_id, prompt),
			catch: toHerdrError,
		});
		const submit = yield* ensurePromptSubmitted(acquired.pane_id, prompt);
		return {
			pane_id: acquired.pane_id,
			label: acquired.label,
			reused: acquired.reused,
			prompt_accepted: submit.accepted,
			prompt_attempts: submit.attempts,
			last_status: submit.last_status,
		};
	});
}

/**
 * Thin Herdr service: pane lifecycle, interactive-prompt dispatch, and
 * floating-oneshot popups. Depends on nothing (spawns + node:fs directly,
 * like `VcsLive`'s `run`).
 */
export const HerdrLive = Layer.effect(
	Herdr,
	Effect.sync(() =>
		Herdr.of({
			enabled: Effect.sync(herdrEnabledSync),

			version: Effect.sync(herdrVersionSync),

			hasApneaPlugin: Effect.sync(hasApneaPluginSync),

			paneGet: (paneId) => Effect.sync(() => paneGetSync(paneId)),

			paneRun: (paneId, command) =>
				Effect.try({
					try: () => paneRunSync(paneId, command),
					catch: toHerdrError,
				}),

			paneForegroundNames: (paneId) =>
				Effect.sync(() => paneForegroundNamesSync(paneId)),

			runInteractivePrompt: runInteractivePromptImpl,

			writeFloatingTaskScript: (scriptAbs, root, cmd, prompt, exitFileAbs) =>
				Effect.try({
					try: () => {
						if (cmd.length === 0) {
							throw new HerdrError({
								message:
									"floating oneshot cmd is empty; set cmd_oneshot on the role profile",
							});
						}
						const bin = cmd[0];
						if (bin === undefined || bin === "") {
							throw new HerdrError({
								message:
									"floating oneshot binary is empty; set cmd_oneshot on the role profile",
							});
						}
						const resolved = resolveExecutable(bin);
						if (!resolved) {
							throw new HerdrError({
								message: `floating oneshot binary "${bin}" not found on PATH; use an absolute cmd_oneshot or set pane_style=regular`,
							});
						}
						const resolvedCmd = [resolved, ...cmd.slice(1)];
						// No `exec`: EXIT trap must run after the oneshot exits (Hangup
						// included). End-of-options `--` before the prompt so variadic
						// flags like Claude's `--allowedTools <tools...>` cannot swallow
						// the prompt as another tool.
						const body = floatingTaskScriptBody({
							root,
							resolvedCmd,
							prompt,
							exitFileAbs,
						});
						fs.writeFileSync(scriptAbs, body, "utf8");
						fs.chmodSync(scriptAbs, 0o755);
					},
					catch: toHerdrError,
				}),

			openFloatingPane: (taskScriptAbs, _root) =>
				Effect.try({
					try: () => {
						const r = herdrCli([
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
								throw new HerdrError({
									message:
										"floating popup already open — herdr allows only one; dismiss it or workflow_wait for the in-flight oneshot before dispatching again",
								});
							}
							throw new HerdrError({
								message: `herdr plugin pane open failed: ${raw || r.raw}`,
							});
						}
					},
					catch: toHerdrError,
				}),

			linkPlugin: (dir) =>
				Effect.sync(() => {
					const r = herdrCli(["plugin", "link", dir]);
					return { ok: r.ok, raw: r.raw };
				}),
		}),
	),
);
