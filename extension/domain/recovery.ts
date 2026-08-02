import type { RunState } from "./types.ts";

/**
 * Clear the recovery ladder's per-dispatch state.
 *
 * These fields are facts about ONE in-flight dispatch: whether it was nudged,
 * whether it consumed its one-time extension, whether it took the final grace.
 * A new dispatch must start from none of them, and an ingested artifact must
 * leave none behind.
 *
 * A shared helper because the block was previously copy-pasted at four sites
 * (`start`, both `dispatch` save paths, and `wait`'s advance). Adding a rung
 * meant editing four places, and missing one leaves a stale flag that makes
 * the new rung fire immediately against a freshly dispatched role — the exact
 * failure class that made this file's history what it is.
 *
 * `pending_started_at` and `pending_deadline_ms` are deliberately NOT reset
 * here: dispatch sets them to real values in the same breath, and clearing
 * them first would let a caller observe a pending role with no deadline.
 */
export function resetRecoveryLadder(state: RunState): void {
	state.pending_nudged_at = null;
	state.pending_final_grace = false;
	state.pending_extended = false;
}
