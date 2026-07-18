import { loadConfig } from "../lib/config.ts";
import { err, ok } from "../lib/result.ts";
import { LEGAL_TOOLS } from "../lib/state-machine.ts";
import {
	getRound,
	loadState,
	requireState,
	saveState,
	setRound,
} from "../lib/state.ts";
import type { ToolResult } from "../lib/types.ts";
import { detectVcs, isDirty } from "../lib/vcs.ts";

/** Read-only. Never mutates. */
export function workflowStatus(): ToolResult {
	const root = process.cwd();
	const state = loadState(root);
	if (!state) {
		return ok("no active run", { has_state: false });
	}
	let cfgSummary: Record<string, unknown> = {};
	try {
		const cfg = loadConfig(root);
		cfgSummary = {
			roles: cfg.roles,
			review_round_cap: cfg.review_round_cap,
		};
	} catch (e) {
		cfgSummary = { config_error: e instanceof Error ? e.message : String(e) };
	}
	const vcs = detectVcs(root);
	return ok(`step=${state.step} phase=${state.phase_index}`, {
		state,
		legal_tools: LEGAL_TOOLS[state.step],
		config: cfgSummary,
		dirty: vcs ? isDirty(root, vcs) : null,
	});
}

/** Human-only. Not for orchestrator allowlist. */
export function workflowResetRounds(params: { gate: string }): ToolResult {
	const root = process.cwd();
	let state;
	try {
		state = requireState(root);
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
	const key = params.gate;
	const prev = getRound(state, key);
	setRound(state, key, 1);
	state.last_error = null;
	saveState(state, root);
	return ok(`reset rounds for ${key}: ${prev} → 1`, {
		note: "human-only tool; orchestrator must not call this",
	});
}
