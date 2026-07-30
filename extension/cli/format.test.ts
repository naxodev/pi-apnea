import { describe, expect, test } from "bun:test";
import { exitCodeFor, renderHuman, renderJson } from "./format.ts";

describe("exitCodeFor", () => {
	test("ready artifact exits 0", () => {
		expect(exitCodeFor({ ok: true, message: "artifact ready" })).toBe(0);
	});

	test("pending wait exits 3, not 0", () => {
		// An agent must be able to tell "call wait again" from "done" without
		// parsing prose. Both are ok:true, so only the exit code separates them.
		expect(
			exitCodeFor({ ok: true, message: "still waiting", data: { pending: true } }),
		).toBe(3);
	});

	test("refusal exits 1", () => {
		expect(exitCodeFor({ ok: false, error: "illegal tool" })).toBe(1);
	});
});

describe("renderHuman", () => {
	test("renders legal_next as runnable commands, not tool names", () => {
		// A CLI caller cannot "call dispatch_role" — it has to run a command.
		const out = renderHuman({
			ok: true,
			message: "run started",
			legal_next: ["dispatch_role", "workflow_wait"],
		});
		expect(out).toContain("apnea dispatch");
		expect(out).toContain("apnea wait");
		expect(out).not.toContain("dispatch_role");
	});
});

describe("renderHuman: unmapped legal_next entries", () => {
	test("a tool name with no registered CLI verb is dropped, not leaked raw", () => {
		// Regression guard: LEGAL_TOOLS once advertised `workflow_reset_rounds`,
		// a tool that was never registered — asCommand's old fallback rendered
		// it verbatim as if it were a runnable command. A bare, unmapped,
		// tool-name-shaped string must never reach rendered output again.
		const out = renderHuman({
			ok: true,
			message: "run started",
			legal_next: ["workflow_reset_rounds"],
		});
		expect(out).not.toContain("workflow_reset_rounds");
		expect(out).not.toContain("next:");
	});

	test("a human-readable hint (contains whitespace) still renders", () => {
		const out = renderHuman({
			ok: false,
			error: "kind not allowed",
			legal_next: ["dispatch_role with allowed kind"],
		});
		expect(out).toContain("dispatch_role with allowed kind");
	});
});

describe("renderJson", () => {
	test("preserves canonical tool names for machine callers", () => {
		// JSON consumers key off stable identifiers; verb rendering is a
		// presentation concern and must not leak into the data.
		const out = JSON.parse(
			renderJson({ ok: true, message: "run started", legal_next: ["dispatch_role"] }),
		);
		expect(out.legal_next).toEqual(["dispatch_role"]);
	});
});
