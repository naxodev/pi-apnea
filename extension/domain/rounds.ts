import type { RunState } from "../lib/types.ts";

export function roundKey(phaseIndex: number, gate: string): string {
	if (gate === "plan_review") return "plan_review";
	if (gate === "finishing") return "finishing";
	const n = String(phaseIndex).padStart(2, "0");
	return `phase-${n}/${gate}`;
}

export function getRound(state: RunState, key: string): number {
	return state.rounds[key] ?? 1;
}

export function setRound(state: RunState, key: string, n: number): void {
	state.rounds[key] = n;
}
