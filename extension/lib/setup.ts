/**
 * Deterministic Apnea setup: detect binaries, write global profiles
 * (and optional project role bindings). Never writes cmd into project config.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { globalConfigPath, projectConfigPath } from "./paths.ts";
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

	// pi-grok: match Nacho's defaults; users can edit
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
		// oneshot must be able to Write artifacts; toy gate used this exact set
		profiles["claude-fable"] = {
			cmd_oneshot: [
				"claude",
				"-p",
				"--model",
				"claude-fable-5",
				"--allowedTools",
				"Read,Write,Edit,Glob,Grep",
			],
			cmd_interactive: ["claude", "--model", "claude-fable-5"],
		};
	}
	if (has.codex) {
		profiles["codex"] = {
			cmd_oneshot: ["codex", "exec"],
			cmd_interactive: ["codex"],
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

	const globalConfig = {
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

	return ok(`wrote global config ${gPath}`, {
		global: gPath,
		project: projectPath,
		detected: has,
		roles: globalConfig.roles,
		notes: missing,
		next: "edit ~/.config/apnea/config.json if model ids differ, then /apnea start <goal> inside Herdr",
	});
}

export function setupHelp(): string {
	return [
		"/apnea setup              write/merge ~/.config/apnea/config.json from PATH",
		"/apnea setup --project    also write .apnea/config.json role bindings (no cmds)",
		"/apnea setup --force      replace global profiles/roles instead of merge",
	].join("\n");
}
