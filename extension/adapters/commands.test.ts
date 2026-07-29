import { describe, expect, test } from "bun:test";
import { OPERATIONS } from "../registry.ts";
import { parseFlags, SUBS } from "./commands.ts";

describe("parseFlags", () => {
	test("bare switches land in flags, positionals in rest", () => {
		const { flags, values, rest } = parseFlags([
			"code",
			"--rework",
			"extra words",
		]);
		expect(flags.has("rework")).toBe(true);
		expect(rest).toEqual(["code", "extra words"]);
		expect(values.size).toBe(0);
	});

	// `rest` never sees a `--`-prefixed token, so a `--key=value` option is only
	// reachable through `values`. Reading it back out of `rest` silently drops
	// the option — `/apnea wait --timeout=3600000` would fall back to the
	// default budget instead of the caller's chosen one.
	test("--key=value options are exposed as values, never in rest", () => {
		const { flags, values, rest } = parseFlags(["--timeout=3600000"]);
		expect(values.get("timeout")).toBe("3600000");
		expect(rest).toEqual([]);
		expect(flags.size).toBe(0);
	});

	test("start-style mix: slug value, allow-dirty switch, goal words", () => {
		const { flags, values, rest } = parseFlags([
			"add",
			"--slug=my-run",
			"dark",
			"--allow-dirty",
			"mode",
		]);
		expect(values.get("slug")).toBe("my-run");
		expect(flags.has("allow-dirty")).toBe(true);
		expect(rest.join(" ")).toBe("add dark mode");
	});

	// `--=x` has no key; treating it as one would create an empty-named option.
	test("a leading = is not a key/value split", () => {
		const { flags, values } = parseFlags(["--=x"]);
		expect(values.size).toBe(0);
		expect(flags.has("=x")).toBe(true);
	});
});

describe("Pi tool exposure", () => {
	test("workflow_reset_rounds is not registered as a model tool", () => {
		// ADR 0002 claims the orchestrator cannot lift its own rework cap.
		// The only enforceable version of that claim is: the model has no tool
		// for it. The CLI's TTY gate covers the human path.
		const tools = OPERATIONS.map((o) => o.tool).filter(Boolean);
		expect(tools).not.toContain("workflow_reset_rounds");
	});

	test("every /apnea subcommand has a registry entry", () => {
		// SUBS used to be a hand-maintained literal that could drift from the
		// actual dispatch switch below it.
		for (const sub of SUBS) {
			if (sub === "help") continue;
			// resume and abandon are actions on the start operation
			const verb = sub === "resume" || sub === "abandon" ? "start" : sub;
			expect(OPERATIONS.some((o) => o.verb === verb)).toBe(true);
		}
	});
});
