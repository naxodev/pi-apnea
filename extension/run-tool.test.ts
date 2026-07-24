import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { IllegalTool } from "./errors.ts";
import { runTool } from "./run-tool.ts";
import { itEffect } from "./test/it-effect.ts";

describe("runTool", () => {
	test("success maps to ok ToolResult content", async () => {
		const out = await runTool(
			Effect.succeed({ ok: true as const, message: "hello" }),
			Layer.empty,
		);
		expect(out.details.ok).toBe(true);
		if (out.details.ok) expect(out.details.message).toBe("hello");
		expect(out.content[0]?.text).toContain("OK: hello");
	});

	test("IllegalTool maps to ok:false with legal_next", async () => {
		const out = await runTool(
			Effect.fail(
				new IllegalTool({
					step: "done",
					tool: "dispatch_role",
					legal: ["workflow_status"],
				}),
			),
			Layer.empty,
		);
		expect(out.details.ok).toBe(false);
		if (!out.details.ok) {
			expect(out.details.legal_next).toEqual(["workflow_status"]);
			expect(out.details.error).toContain("illegal tool dispatch_role");
			expect(out.details.error).toContain("step=done");
		}
	});

	test("defect maps to bug: message and does not reject", async () => {
		const out = await runTool(
			Effect.sync(() => {
				throw new Error("kaboom");
			}) as Effect.Effect<never>,
			Layer.empty,
		);
		expect(out.details.ok).toBe(false);
		if (!out.details.ok) {
			expect(out.details.error).toBe("bug: kaboom");
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
