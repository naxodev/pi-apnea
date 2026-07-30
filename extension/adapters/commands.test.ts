import { describe, expect, test } from "bun:test";
import { OPERATIONS } from "../registry.ts";

describe("Pi tool exposure", () => {
	test("workflow_reset_rounds is not registered as a model tool", () => {
		// ADR 0002 claims the orchestrator cannot lift its own rework cap.
		// The only enforceable version of that claim is: the model has no tool
		// for it. The CLI's TTY gate covers the human path.
		const tools = OPERATIONS.map((o) => o.tool).filter(Boolean);
		expect(tools).not.toContain("workflow_reset_rounds");
	});
});

// The "every /apnea subcommand has a registry entry" check used to live here
// as `SUBS.every(sub => OPERATIONS.some(...))`. SUBS is *derived from*
// OPERATIONS.map(o => o.verb), so that assertion was true by construction —
// it never inspected the switch statement it claimed to guard. It's now
// commands.dispatch.test.ts, which drives the real handler per registry verb
// and asserts none of them falls through to the unknown-subcommand branch.
