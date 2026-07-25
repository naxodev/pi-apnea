import { describe, expect, test } from "bun:test";
import { floatingTaskScriptBody, looksLikeShellOnly, parseFloatingExit } from "./herdr.ts";

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
