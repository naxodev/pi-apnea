import * as fs from "node:fs";
import { getRound, roundKey, setRound } from "../domain/rounds.ts";
import { ensureApneaDirs, statePath } from "./paths.ts";
import type { RunState, Step } from "./types.ts";

export { getRound, roundKey, setRound };

export function loadState(root?: string): RunState | null {
	const p = statePath(root);
	if (!fs.existsSync(p)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(p, "utf8")) as RunState;
		// tolerate older state files missing pane-tracking fields
		raw.pending_pane_id ??= null;
		raw.pending_pane_label ??= null;
		raw.pending_floating_exit ??= null;
		raw.role_panes ??= {};
		return raw;
	} catch (e) {
		throw new Error(
			`corrupt state at ${p}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

export function saveState(state: RunState, root?: string): void {
	ensureApneaDirs(root);
	const p = statePath(root);
	fs.writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function requireState(root?: string): RunState {
	const s = loadState(root);
	if (!s) throw new Error("no run state; call workflow_start first");
	return s;
}

export function setStep(state: RunState, step: Step, root?: string): RunState {
	state.step = step;
	state.last_error = null;
	saveState(state, root);
	return state;
}
