import { Effect } from "effect";
import { getRound, setRound } from "../domain/rounds.ts";
import type { AppError } from "../errors.ts";
import { ok, type ToolResult } from "../result.ts";
import { RunStore } from "../services/run-store.ts";

/**
 * Human-only: reset rework counter for a gate key.
 * Missing/corrupt state → NoRunState / StateCorrupt.
 */
export const resetRoundsWorkflow = (
	params: { gate: string },
	root: string,
): Effect.Effect<ToolResult, AppError, RunStore> =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		const state = yield* store.require(root);
		const key = params.gate;
		const prev = getRound(state, key);
		setRound(state, key, 1);
		state.last_error = null;
		yield* store.save(state, root);
		return ok(`reset rounds for ${key}: ${prev} → 1`, {
			note: "human-only tool; orchestrator must not call this",
		});
	});
