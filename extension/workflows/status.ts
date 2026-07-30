import { Effect, Result } from "effect";
import { LEGAL_TOOLS, nextAfter } from "../domain/state-machine.ts";
import type { StateCorrupt } from "../errors.ts";
import { ok, type ToolResult } from "../result.ts";
import { Config } from "../services/config.ts";
import { RunStore } from "../services/run-store.ts";
import { Vcs } from "../services/vcs.ts";

/**
 * Read-only snapshot. Missing state is a success (`has_state: false`),
 * not NoRunState. Corrupt state may fail as StateCorrupt.
 */
export const statusWorkflow = (
	root: string,
): Effect.Effect<ToolResult, StateCorrupt, RunStore | Config | Vcs> =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		const config = yield* Config;
		const vcsSvc = yield* Vcs;
		const state = yield* store.load(root);
		if (!state) {
			return ok("no active run", { has_state: false }, ["workflow_start"]);
		}

		// Config summary never fails the tool
		const cfgR = yield* Effect.result(config.load(root));
		const cfgSummary: Record<string, unknown> = Result.isSuccess(cfgR)
			? {
					roles: cfgR.success.roles,
					review_round_cap: cfgR.success.review_round_cap,
				}
			: { config_error: cfgR.failure.message };

		const vcs = yield* vcsSvc.detect(root);
		return ok(
			`step=${state.step} phase=${state.phase_index}`,
			{
				state,
				legal_tools: LEGAL_TOOLS[state.step],
				config: cfgSummary,
				dirty: vcs ? yield* vcsSvc.isDirty(root, vcs) : null,
			},
			nextAfter(state.step),
		);
	});
