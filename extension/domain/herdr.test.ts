import { describe, expect, test } from "bun:test";
import {
	effectivePaneStyle,
	floatingTaskScriptBody,
	looksLikeShellOnly,
	parseFloatingExit,
	parseHerdrVersion,
	supportsFloating,
	versionGte,
} from "./herdr.ts";
import type { Role } from "./types.ts";

describe("parseHerdrVersion", () => {
	// Version gate is the only thing between a user and a popup flag their herdr lacks.
	test("parses herdr X.Y.Z line", () => {
		expect(parseHerdrVersion("herdr 0.7.3")).toEqual([0, 7, 3]);
	});

	test("accepts multi-line/noisy output", () => {
		expect(parseHerdrVersion("info\nherdr 0.7.4\nextra")).toEqual([0, 7, 4]);
	});

	test("garbage → null (fail closed)", () => {
		expect(parseHerdrVersion("not a version")).toBeNull();
		expect(parseHerdrVersion("")).toBeNull();
	});
});

describe("supportsFloating / version compare", () => {
	// Fail-closed keeps unattended runs from hanging on a CLI error mid-dispatch;
	// numeric compare guards against string-compare bugs (0.10.x > 0.7.x).
	test("0.7.3 false, 0.7.4+ true, unparseable false", () => {
		expect(supportsFloating([0, 7, 3])).toBe(false);
		expect(supportsFloating([0, 7, 4])).toBe(true);
		expect(supportsFloating([0, 8, 0])).toBe(true);
		expect(supportsFloating([1, 0, 0])).toBe(true);
		expect(supportsFloating([0, 10, 0])).toBe(true);
		expect(supportsFloating(null)).toBe(false);
	});

	test("versionGte is numeric, not lexical", () => {
		expect(versionGte([0, 10, 0], [0, 7, 4])).toBe(true);
		expect(versionGte([0, 7, 3], [0, 7, 4])).toBe(false);
		expect(versionGte([0, 7, 4], [0, 7, 4])).toBe(true);
	});
});

describe("effectivePaneStyle", () => {
	// Interactive-role downgrade must be *reported*, never silent.
	const roles: Role[] = ["planner", "reviewer", "coder", "orchestrator"];

	test("regular config → regular for every role", () => {
		for (const role of roles) {
			expect(effectivePaneStyle("regular", role)).toEqual({
				style: "regular",
				effective: "regular",
			});
		}
	});

	test("floating + planner/reviewer → floating", () => {
		for (const role of ["planner", "reviewer"] as Role[]) {
			expect(effectivePaneStyle("floating", role)).toEqual({
				style: "floating",
				effective: "floating",
			});
		}
	});

	test("floating + coder/orchestrator → regular with explicit reason", () => {
		for (const role of ["coder", "orchestrator"] as Role[]) {
			expect(effectivePaneStyle("floating", role)).toEqual({
				style: "regular",
				effective: "regular (interactive role)",
			});
		}
	});
});

describe("parseFloatingExit", () => {
	// A mis-parse makes wait hang forever (null when a code was actually
	// written) or fail a live oneshot outright (garbage read as a real code).
	test("parses a written exit code", () => {
		expect(parseFloatingExit("42\n")).toBe(42);
	});

	test("empty or garbage → null", () => {
		expect(parseFloatingExit("")).toBeNull();
		expect(parseFloatingExit("not-a-number")).toBeNull();
	});
});

describe("looksLikeShellOnly", () => {
	// Only a pane whose *entire* foreground is a bare shell counts as
	// harness-exited; any real process in the mix means still working.
	test("all-shell foreground → true", () => {
		expect(looksLikeShellOnly(["zsh"])).toBe(true);
		expect(looksLikeShellOnly(["-bash"])).toBe(true);
		expect(looksLikeShellOnly(["fish", "-sh"])).toBe(true);
	});

	test("mixed foreground → false", () => {
		expect(looksLikeShellOnly(["zsh", "vim"])).toBe(false);
	});

	test("empty foreground → false (an unreadable pane must not be killed)", () => {
		expect(looksLikeShellOnly([])).toBe(false);
	});
});

describe("floatingTaskScriptBody", () => {
	test("shebang, exit trap, signal traps, quoted cd, end-of-options, no bare exec, escaped prompt", () => {
		const prompt = "line1\nline2's quote";
		const body = floatingTaskScriptBody({
			root: "/tmp/project with spaces",
			resolvedCmd: ["/usr/local/bin/pi", "-p"],
			prompt,
			exitFileAbs: "/tmp/task.exit",
		});

		expect(body.startsWith("#!/bin/bash\n")).toBe(true);
		expect(body).toContain("set -uo pipefail\n");
		expect(body).toContain("EXIT_FILE=/tmp/task.exit");
		expect(body).toContain("trap write_exit EXIT");
		expect(body).toContain("trap 'exit 129' HUP");
		expect(body).toContain("trap 'exit 130' INT");
		expect(body).toContain("trap 'exit 143' TERM");
		// quoted cd: root contains a space, so shellJoin must single-quote it
		expect(body).toContain("cd '/tmp/project with spaces'");
		// end-of-options before the prompt so variadic flags cannot eat it
		expect(body).toContain(" -- ");
		// no bare exec — the EXIT trap must outlive the oneshot
		expect(body).not.toMatch(/\bexec\b/);
		// prompt appears as a single-quoted argv (shellJoin escaping)
		expect(body).toContain(`'${prompt.replace(/'/g, `'\\''`)}'`);
		expect(body.endsWith("\n")).toBe(true);
	});
});
