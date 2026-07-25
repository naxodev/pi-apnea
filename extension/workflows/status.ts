import { Effect } from "effect";
import { LEGAL_TOOLS } from "../domain/state-machine.ts";
import type { StateCorrupt } from "../errors.ts";
import { loadConfig } from "../lib/config.ts";
import { detectVcs, isDirty } from "../lib/vcs.ts";
import { ok, type ToolResult } from "../result.ts";
import { RunStore } from "../services/run-store.ts";

/**
 * Read-only snapshot. Missing state is a success (`has_state: false`),
 * not NoRunState. Corrupt state may fail as StateCorrupt.
 */
export const statusWorkflow = (
	root: string,
): Effect.Effect<ToolResult, StateCorrupt, RunStore> =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		const state = yield* store.load(root);
		if (!state) {
			return ok("no active run", { has_state: false });
		}

		// Phase 3: Config/Vcs service — config summary never fails the tool
		let cfgSummary: Record<string, unknown> = {};
		try {
			const cfg = loadConfig(root);
			cfgSummary = {
				roles: cfg.roles,
				review_round_cap: cfg.review_round_cap,
			};
		} catch (e) {
			cfgSummary = {
				config_error: e instanceof Error ? e.message : String(e),
			};
		}

		// Phase 3: Config/Vcs service
		const vcs = detectVcs(root);
		return ok(`step=${state.step} phase=${state.phase_index}`, {
			state,
			legal_tools: LEGAL_TOOLS[state.step],
			config: cfgSummary,
			dirty: vcs ? isDirty(root, vcs) : null,
		});
	});
