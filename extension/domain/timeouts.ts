import type { DispatchKind } from "./state-machine.ts";

/**
 * Dispatch kind → the `timeouts_ms` key documented in docs/protocol/config.md.
 * Non-nullable on purpose: a kind mapped to `null` silently ignores whatever
 * the user configured, and reports the default back as if it were their value.
 */
const STEP_KEY: Record<DispatchKind, string> = {
	plan: "planning",
	plan_review: "plan_review",
	phase_package: "phase_packaging",
	code: "coding",
	code_review: "code_review",
	pr_description: "finishing",
};

export const DEFAULT_TIMEOUT_MS = 900_000;

export function timeoutMsForKind(
	kind: DispatchKind,
	timeouts: Record<string, number>,
): number {
	return (
		timeouts[STEP_KEY[kind]] ?? timeouts.default ?? DEFAULT_TIMEOUT_MS
	);
}
