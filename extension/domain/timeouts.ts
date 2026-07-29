import type { DispatchKind } from "./state-machine.ts";

/** Dispatch kind → the `timeouts_ms` key documented in docs/protocol/config.md. */
const STEP_KEY: Record<DispatchKind, string | null> = {
	plan: "planning",
	plan_review: "plan_review",
	phase_package: "phase_packaging",
	code: "coding",
	code_review: "code_review",
	// No dedicated key documented; PR description is short and uses default.
	pr_description: null,
};

export const DEFAULT_TIMEOUT_MS = 900_000;

export function timeoutMsForKind(
	kind: DispatchKind,
	timeouts: Record<string, number>,
): number {
	const key = STEP_KEY[kind];
	const specific = key ? timeouts[key] : undefined;
	return specific ?? timeouts.default ?? DEFAULT_TIMEOUT_MS;
}
