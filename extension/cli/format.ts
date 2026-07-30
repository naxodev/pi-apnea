import { toolToVerb } from "../registry.ts";
import type { ToolResult } from "../result.ts";

/** 0 ready · 1 refusal/error · 2 usage · 3 wait budget spent, call again. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_PENDING = 3;

export function exitCodeFor(r: ToolResult): number {
	if (!r.ok) return EXIT_ERROR;
	return r.data?.pending === true ? EXIT_PENDING : EXIT_OK;
}

/**
 * Canonical tool name → the command a shell caller actually runs, or `null`
 * when `tool` isn't a runnable command: either it's already a human-readable
 * hint (contains whitespace, e.g. "dispatch_role with allowed kind") that
 * should render unchanged, or it's a bug — a tool-name-shaped string with no
 * CLI verb behind it (e.g. a tool that was deleted from `LEGAL_TOOLS` but
 * left in some error's `legal_next`). Returning `null` for the latter instead
 * of the raw string keeps a dangling tool name from silently reaching
 * rendered output.
 */
function asCommand(tool: string): string | null {
	const verb = toolToVerb(tool);
	if (verb) return `apnea ${verb}`;
	return /\s/.test(tool) ? tool : null;
}

export function renderHuman(r: ToolResult): string {
	const mapped = (r.legal_next ?? [])
		.map(asCommand)
		.filter((c): c is string => c !== null);
	const next = mapped.length ? `\nnext: ${mapped.join(" | ")}` : "";
	const extra = r.data ? `\n${JSON.stringify(r.data, null, 2)}` : "";
	return r.ok
		? `OK: ${r.message}${next}${extra}`
		: `ERROR: ${r.error}${next}${extra}`;
}

export function renderJson(r: ToolResult): string {
	return JSON.stringify(r);
}
