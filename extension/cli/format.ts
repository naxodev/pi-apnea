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

/** Canonical tool name → the command a shell caller actually runs. */
function asCommand(tool: string): string {
	const verb = toolToVerb(tool);
	return verb ? `apnea ${verb}` : tool;
}

export function renderHuman(r: ToolResult): string {
	const next = r.legal_next?.length
		? `\nnext: ${r.legal_next.map(asCommand).join(" | ")}`
		: "";
	const extra = r.data ? `\n${JSON.stringify(r.data, null, 2)}` : "";
	return r.ok
		? `OK: ${r.message}${next}${extra}`
		: `ERROR: ${r.error}${next}${extra}`;
}

export function renderJson(r: ToolResult): string {
	return JSON.stringify(r);
}
