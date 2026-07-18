import type { ToolResult } from "./types.ts";

export function ok(
	message: string,
	data?: Record<string, unknown>,
): ToolResult {
	return data ? { ok: true, message, data } : { ok: true, message };
}

export function err(
	error: string,
	opts?: { legal_next?: string[]; data?: Record<string, unknown> },
): ToolResult {
	return {
		ok: false,
		error,
		legal_next: opts?.legal_next,
		data: opts?.data,
	};
}

export function formatResult(r: ToolResult): string {
	if (r.ok) {
		const extra = r.data ? `\n${JSON.stringify(r.data, null, 2)}` : "";
		return `OK: ${r.message}${extra}`;
	}
	const legal = r.legal_next?.length
		? `\nlegal_next: ${r.legal_next.join(", ")}`
		: "";
	const extra = r.data ? `\n${JSON.stringify(r.data, null, 2)}` : "";
	return `ERROR: ${r.error}${legal}${extra}`;
}

export function toolContent(r: ToolResult) {
	return {
		content: [{ type: "text" as const, text: formatResult(r) }],
		details: r,
	};
}
