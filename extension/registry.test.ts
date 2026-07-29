import { describe, expect, test } from "bun:test";
import { OPERATIONS, findByTool, findByVerb, toolToVerb } from "./registry.ts";

describe("OPERATIONS", () => {
	test("pins the exact command set", () => {
		// Adding or renaming a command must be a deliberate edit here, not a
		// silent divergence between the Pi driver and the CLI.
		expect(OPERATIONS.map((o) => o.verb).sort()).toEqual([
			"commit",
			"dispatch",
			"reset-rounds",
			"setup",
			"start",
			"status",
			"wait",
		]);
	});

	test("verbs are unique", () => {
		const verbs = OPERATIONS.map((o) => o.verb);
		expect(new Set(verbs).size).toBe(verbs.length);
	});

	test("tool names are unique among model-facing operations", () => {
		const tools = OPERATIONS.map((o) => o.tool).filter(
			(t): t is string => t !== null,
		);
		expect(new Set(tools).size).toBe(tools.length);
	});

	test("setup and reset-rounds are not model-facing", () => {
		// reset-rounds is human-only (TTY-gated); setup writes global config.
		// Exposing either as a Pi tool would let the orchestrator call it.
		expect(findByVerb("setup")?.tool).toBeNull();
		expect(findByVerb("reset-rounds")?.tool).toBeNull();
	});

	test("reset-rounds is the only humanOnly operation", () => {
		expect(OPERATIONS.filter((o) => o.humanOnly).map((o) => o.verb)).toEqual([
			"reset-rounds",
		]);
	});

	test("every model-facing operation carries a param schema", () => {
		for (const op of OPERATIONS) {
			if (op.tool !== null) expect(op.params).toBeDefined();
		}
	});

	test("tool names map back to CLI verbs", () => {
		// This mapping is what renders `legal_next: ["dispatch_role"]` as
		// `apnea dispatch` for a CLI caller.
		expect(toolToVerb("dispatch_role")).toBe("dispatch");
		expect(toolToVerb("workflow_wait")).toBe("wait");
		expect(toolToVerb("workflow_reset_rounds")).toBeNull();
		expect(findByTool("workflow_status")?.verb).toBe("status");
	});

	test("start refuses a missing goal instead of throwing", async () => {
		// Regression guard for the registry owning the same validation
		// index.ts's execute() applies before calling workflowStart — without
		// it, action=start with no goal reaches slugify(undefined) downstream
		// and throws instead of returning a clean refusal.
		const result = await findByVerb("start")!.run({ action: "start" });
		expect(result).toEqual({
			ok: false,
			error: "goal is required when action=start",
		});
	});
});
