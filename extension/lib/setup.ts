/**
 * Deterministic Apnea setup: detect binaries, write global profiles
 * (and optional project role bindings). Never writes cmd into project config.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasApneaPlugin, herdrVersion, supportsFloating } from "./herdr.ts";
import { globalConfigPath, packageRoot, projectConfigPath } from "./paths.ts";
import { materializePiRoleAgentDir } from "../services/pi-role-agent.ts";
import { err, ok } from "./result.ts";
import type { ToolResult } from "./types.ts";

function onPath(bin: string): boolean {
	const r = spawnSync("which", [bin], { encoding: "utf8" });
	return r.status === 0 && Boolean(r.stdout?.trim());
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const v = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (v && typeof v === "object" && !Array.isArray(v)) {
			return v as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function deepMergeProfiles(
	existing: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...existing };
	for (const [k, v] of Object.entries(incoming)) {
		if (!(k in out)) out[k] = v;
	}
	return out;
}

/**
 * Carry a valid user pane_style preference forward. Setup never writes the
 * key when absent, and never invents values — only preserves exact "regular"
 * or "floating". Invalid prev values are dropped.
 */
export function preservePaneStyle(
	prev: Record<string, unknown>,
): "regular" | "floating" | undefined {
	const v = prev.pane_style;
	if (v === "regular" || v === "floating") return v;
	return undefined;
}

export type ProvisionResult = {
	copied: string | null; // dest dir, or null when skipped
	linked: boolean; // true only when we ran `herdr plugin link` OK
	already_linked: boolean;
	notes: string[];
};

/**
 * Copy the package's herdr-plugin into a stable config-local path and, when
 * herdr is new enough and the plugin isn't already linked, run
 * `herdr plugin link`. Dependencies are injected so tests never touch the
 * real home dir or spawn herdr.
 */
export function provisionHerdrPlugin(opts: {
	srcDir: string; // packageRoot()/herdr-plugin
	destDir: string; // dirname(globalConfigPath())/herdr-plugin
	version: [number, number, number] | null; // herdrVersion()
	hasPlugin: () => boolean; // hasApneaPlugin
	link: (dir: string) => { ok: boolean; raw: string }; // spawns `herdr plugin link <dir>`
}): ProvisionResult {
	const notes: string[] = [];

	if (!fs.existsSync(opts.srcDir)) {
		notes.push("herdr-plugin missing from package — reinstall @naxodev/apnea");
		return {
			copied: null,
			linked: false,
			already_linked: false,
			notes,
		};
	}

	fs.cpSync(opts.srcDir, opts.destDir, { recursive: true, force: true });
	const runTask = path.join(opts.destDir, "scripts", "run-task.sh");
	if (fs.existsSync(runTask)) {
		fs.chmodSync(runTask, 0o755);
	}

	if (!supportsFloating(opts.version)) {
		const ver =
			opts.version == null
				? "unknown"
				: `${opts.version[0]}.${opts.version[1]}.${opts.version[2]}`;
		notes.push(
			`herdr ${ver} < 0.7.4 — floating panes unavailable; run \`herdr update\`, then re-run /apnea setup`,
		);
		return {
			copied: opts.destDir,
			linked: false,
			already_linked: false,
			notes,
		};
	}

	if (opts.hasPlugin()) {
		return {
			copied: opts.destDir,
			linked: false,
			already_linked: true,
			notes,
		};
	}

	const linkResult = opts.link(opts.destDir);
	if (!linkResult.ok) {
		notes.push(
			`herdr plugin link failed: ${linkResult.raw.trim() || "(no output)"}`,
		);
		return {
			copied: opts.destDir,
			linked: false,
			already_linked: false,
			notes,
		};
	}

	return {
		copied: opts.destDir,
		linked: true,
		already_linked: false,
		notes,
	};
}

function linkHerdrPlugin(dir: string): { ok: boolean; raw: string } {
	const r = spawnSync("herdr", ["plugin", "link", dir], {
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});
	const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	return { ok: r.status === 0, raw };
}

export function apneaSetup(params: {
	/** Write .apnea/config.json role bindings in cwd */
	project?: boolean;
	/** Overwrite existing global profiles (default: merge, keep existing profile keys) */
	force?: boolean;
	cwd?: string;
}): ToolResult {
	const root = params.cwd ?? process.cwd();
	const has = {
		pi: onPath("pi"),
		claude: onPath("claude"),
		codex: onPath("codex"),
		herdr: onPath("herdr"),
		jj: onPath("jj"),
		git: onPath("git"),
	};

	if (!has.pi) {
		return err("pi not on PATH — install pi before apnea setup");
	}

	const profiles: Record<string, unknown> = {};

	// pi-grok: match Nacho's defaults; users can edit.
	// Interactive launches inject PI_CODING_AGENT_DIR without pi-vimmode at
	// dispatch time (see wrapInteractiveCmdNoVim) — profiles stay clean.
	profiles["pi-grok"] = {
		cmd_interactive: ["pi", "--provider", "grok-cli", "--model", "grok-4.5"],
		cmd_oneshot: ["pi", "-p", "--provider", "grok-cli", "--model", "grok-4.5"],
	};
	// generic pi fallback for oneshot/interactive without grok
	profiles["pi-default"] = {
		cmd_interactive: ["pi"],
		cmd_oneshot: ["pi", "-p"],
	};

	if (has.claude) {
		// Interactive TUI only for Apnea dispatch (watchable in Herdr).
		// cmd_oneshot kept optional for other tooling; Apnea does not use it.
		profiles["claude-fable"] = {
			cmd_interactive: ["claude", "--model", "claude-fable-5"],
			cmd_oneshot: [
				"claude",
				"-p",
				"--model",
				"claude-fable-5",
				"--allowedTools",
				"Read,Write,Edit,Glob,Grep",
			],
		};
	}
	if (has.codex) {
		profiles["codex"] = {
			cmd_interactive: ["codex"],
			cmd_oneshot: ["codex", "exec"],
		};
	}

	const plannerProfile = has.claude
		? "claude-fable"
		: has.codex
			? "codex"
			: "pi-default";
	const coderProfile = "pi-grok";

	const roles = {
		orchestrator: { profile: coderProfile },
		planner: { profile: plannerProfile },
		reviewer: { profile: plannerProfile },
		coder: { profile: coderProfile },
	};

	const gPath = globalConfigPath();
	fs.mkdirSync(path.dirname(gPath), { recursive: true });

	const prev = readJsonSafe(gPath) ?? {};
	let nextProfiles = profiles;
	if (!params.force && prev.profiles && typeof prev.profiles === "object") {
		nextProfiles = deepMergeProfiles(
			prev.profiles as Record<string, unknown>,
			profiles,
		);
	}

	const preservedPaneStyle = preservePaneStyle(prev);

	const globalConfig: Record<string, unknown> = {
		profiles: nextProfiles,
		roles: params.force || !prev.roles ? roles : prev.roles,
		review_round_cap:
			typeof prev.review_round_cap === "number" ? prev.review_round_cap : 3,
		timeouts_ms:
			prev.timeouts_ms && typeof prev.timeouts_ms === "object"
				? prev.timeouts_ms
				: {
						planning: 1_500_000,
						plan_review: 900_000,
						phase_packaging: 900_000,
						coding: 2_700_000,
						code_review: 900_000,
						verify: 900_000,
					},
	};
	// Preserve user opt-in only — never introduce pane_style when absent.
	if (preservedPaneStyle !== undefined) {
		globalConfig.pane_style = preservedPaneStyle;
	}

	// refuse to write if somehow project-shaped keys snuck in
	const serialized = `${JSON.stringify(globalConfig, null, 2)}\n`;
	fs.writeFileSync(gPath, serialized, "utf8");

	let projectPath: string | null = null;
	if (params.project) {
		const pPath = projectConfigPath(root);
		fs.mkdirSync(path.dirname(pPath), { recursive: true });
		// project: roles only — never cmd
		const projectCfg = {
			roles: {
				orchestrator: { profile: coderProfile },
				planner: { profile: plannerProfile },
				reviewer: { profile: plannerProfile },
				coder: { profile: coderProfile },
			},
		};
		fs.writeFileSync(pPath, `${JSON.stringify(projectCfg, null, 2)}\n`, "utf8");
		projectPath = pPath;
	}

	const missing: string[] = [];
	if (!has.claude && !has.codex) {
		missing.push(
			"no claude/codex — planner/reviewer bound to pi-default (edit global profiles to change)",
		);
	}
	if (!has.herdr) {
		missing.push("herdr not on PATH — pane launch will fail until installed");
	}
	if (!has.jj && !has.git) {
		missing.push("neither jj nor git on PATH — commits will refuse");
	}

	// Pre-build the no-vim pi agent dir so first dispatch is fast.
	let piRoleAgentDir: string | null = null;
	try {
		piRoleAgentDir = materializePiRoleAgentDir();
	} catch (e) {
		missing.push(
			`pi role agent dir failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	let herdrPlugin: ProvisionResult | null = null;
	let herdrVer: string | null = null;
	if (has.herdr) {
		const version = herdrVersion();
		herdrVer =
			version == null ? null : `${version[0]}.${version[1]}.${version[2]}`;
		herdrPlugin = provisionHerdrPlugin({
			srcDir: path.join(packageRoot(), "herdr-plugin"),
			destDir: path.join(path.dirname(globalConfigPath()), "herdr-plugin"),
			version,
			hasPlugin: hasApneaPlugin,
			link: linkHerdrPlugin,
		});
		missing.push(...herdrPlugin.notes);
	}

	const data: Record<string, unknown> = {
		global: gPath,
		project: projectPath,
		detected: has,
		roles: globalConfig.roles,
		notes: missing,
		pi_role_agent_dir: piRoleAgentDir,
		next: "edit ~/.config/apnea/config.json if model ids differ, then /apnea start <goal> inside Herdr",
	};
	if (has.herdr) {
		data.herdr_version = herdrVer;
		data.herdr_plugin = herdrPlugin
			? {
					copied: herdrPlugin.copied,
					linked: herdrPlugin.linked,
					already_linked: herdrPlugin.already_linked,
				}
			: null;
	}

	return ok(`wrote global config ${gPath}`, data);
}

export function setupHelp(): string {
	return [
		"/apnea setup              write/merge ~/.config/apnea/config.json from PATH; also provision the herdr apnea plugin when herdr is present",
		"/apnea setup --project    also write .apnea/config.json role bindings (no cmds)",
		"/apnea setup --force      replace global profiles/roles instead of merge",
	].join("\n");
}
