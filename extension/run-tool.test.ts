import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { GateRefused, IllegalTool } from "./errors.ts";
import { toolContent } from "./result.ts";
import { runToolResult } from "./run-tool.ts";
import { itEffect } from "./test/it-effect.ts";

describe("runToolResult", () => {
	test("success maps to ok ToolResult, and toolContent renders it", async () => {
		const r = await runToolResult(
			Effect.succeed({ ok: true as const, message: "hello" }),
			Layer.empty,
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.message).toBe("hello");
		// index.ts wraps every tool return in toolContent — keep that path covered.
		expect(toolContent(r).content[0]?.text).toContain("OK: hello");
	});

	test("IllegalTool maps to ok:false with legal_next", async () => {
		const r = await runToolResult(
			Effect.fail(
				new IllegalTool({
					step: "done",
					tool: "dispatch_role",
					legal: ["workflow_status"],
				}),
			),
			Layer.empty,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.legal_next).toEqual(["workflow_status"]);
			expect(r.error).toContain("illegal tool dispatch_role");
			expect(r.error).toContain("step=done");
		}
	});

	test("defect maps to bug: message and does not reject", async () => {
		const r = await runToolResult(
			Effect.sync(() => {
				throw new Error("kaboom");
			}) as Effect.Effect<never>,
			Layer.empty,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toBe("bug: kaboom");
		}
	});

	test("returns bare ToolResult", async () => {
		const r = await runToolResult(
			Effect.succeed({ ok: true as const, message: "plain" }),
			Layer.empty,
		);
		expect(r).toEqual({ ok: true, message: "plain" });
	});

	test("GateRefused.details round-trips into ToolResult data", async () => {
		const r = await runToolResult(
			Effect.fail(
				new GateRefused({
					gate: "start",
					message: "state.json already exists (step=planning). Use action=resume or action=abandon.",
					details: { step: "planning", slug: "x" },
				}),
			),
			Layer.empty,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain("already exists");
			expect(r.data?.gate).toBe("start");
			expect(r.data?.step).toBe("planning");
			expect(r.data?.slug).toBe("x");
		}
	});
});

describe("itEffect helper", () => {
	itEffect("runs an effect under bun:test", () =>
		Effect.sync(() => {
			expect(1 + 1).toBe(2);
		}),
	);
});
