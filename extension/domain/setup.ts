import { DEFAULT_TIMEOUTS } from "./types.ts";

export type Detected = {
	pi: boolean;
	claude: boolean;
	codex: boolean;
	herdr: boolean;
	jj: boolean;
	git: boolean;
};

/** Existing keys win over incoming (never overwrite a user's edited profile). */
export function deepMergeProfiles(
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

export function buildProfiles(has: Detected): Record<string, unknown> {
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

	return profiles;
}

export function pickRoles(has: Detected): Record<string, { profile: string }> {
	const plannerProfile = has.claude
		? "claude-fable"
		: has.codex
			? "codex"
			: "pi-default";
	const coderProfile = "pi-grok";

	return {
		orchestrator: { profile: coderProfile },
		planner: { profile: plannerProfile },
		reviewer: { profile: plannerProfile },
		coder: { profile: coderProfile },
	};
}

export function buildGlobalConfig(opts: {
	has: Detected;
	prev: Record<string, unknown>;
	force: boolean;
}): Record<string, unknown> {
	const { has, prev, force } = opts;
	const profiles = buildProfiles(has);
	const roles = pickRoles(has);

	let nextProfiles = profiles;
	if (!force && prev.profiles && typeof prev.profiles === "object") {
		nextProfiles = deepMergeProfiles(
			prev.profiles as Record<string, unknown>,
			profiles,
		);
	}

	const preservedPaneStyle = preservePaneStyle(prev);

	const globalConfig: Record<string, unknown> = {
		profiles: nextProfiles,
		roles: force || !prev.roles ? roles : prev.roles,
		review_round_cap:
			typeof prev.review_round_cap === "number" ? prev.review_round_cap : 3,
		timeouts_ms:
			prev.timeouts_ms && typeof prev.timeouts_ms === "object"
				? prev.timeouts_ms
				: // Seed from the runtime defaults so the written template and the
					// values wait/commit actually use cannot drift apart.
					{ ...DEFAULT_TIMEOUTS },
	};
	// Preserve user opt-in only — never introduce pane_style when absent.
	if (preservedPaneStyle !== undefined) {
		globalConfig.pane_style = preservedPaneStyle;
	}

	return globalConfig;
}

export function detectionNotes(has: Detected): string[] {
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
	return missing;
}
