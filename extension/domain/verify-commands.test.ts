import { describe, expect, test } from "bun:test";
import { extractVerifyCommands } from "./verify-commands.ts";

describe("extractVerifyCommands", () => {
	// Commit gate must run the Verify section, not earlier bash sketches in the package.
	test("prefers fence under ## Verify commands over earlier bash sketches", () => {
		const pkg = `# Phase

Sketch:

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail
if [[ -z "\${APNEA_TASK_SCRIPT:-}" ]]; then
  exit 64
fi
exec bash "$APNEA_TASK_SCRIPT"
\`\`\`

## Verify commands

\`\`\`bash
bunx tsc --noEmit
bun test
# optional:
HERDR_ENV=1 bun test extension/tools --test-name-pattern smoke
\`\`\`

## Do not touch
- other stuff
`;
		expect(extractVerifyCommands(pkg)).toEqual([
			"bunx tsc --noEmit",
			"bun test",
			"HERDR_ENV=1 bun test extension/tools --test-name-pattern smoke",
		]);
	});

	test("falls back to last bash fence when no Verify heading", () => {
		const pkg = `
\`\`\`bash
echo sketch
\`\`\`

\`\`\`bash
bun test
\`\`\`
`;
		expect(extractVerifyCommands(pkg)).toEqual(["bun test"]);
	});

	test("skips comment-only lines", () => {
		const pkg = `## Verify commands
\`\`\`sh
# only a comment
bunx tsc --noEmit
\`\`\`
`;
		expect(extractVerifyCommands(pkg)).toEqual(["bunx tsc --noEmit"]);
	});
});

describe("extractVerifyCommands — line continuations", () => {
	// Hit live: a planner wrote a long grep across two lines, and the gate ran
	// the halves as separate commands. The second half failed with
	// `grep: \: No such file or directory`, so a phase whose 304 tests, tsc,
	// build and tarball checks had all passed was refused, and the message
	// blamed grep rather than the parser. Planners write continuations
	// naturally; this recurred in two consecutive phases.
	test("joins a backslash continuation into one command", () => {
		const pkg = [
			"## Verify commands",
			"",
			"```sh",
			'grep -rl "/Users/" CONTEXT.md briefs \\',
			"  extension dist || echo ok",
			"bun test extension",
			"```",
		].join("\n");
		expect(extractVerifyCommands(pkg)).toEqual([
			'grep -rl "/Users/" CONTEXT.md briefs extension dist || echo ok',
			"bun test extension",
		]);
	});

	test("joins a continuation spanning three lines", () => {
		const pkg = ["```sh", "a \\", "  b \\", "  c", "```"].join("\n");
		expect(extractVerifyCommands(pkg)).toEqual(["a b c"]);
	});

	// An escaped backslash is a literal, not a continuation. `printf 'x\\'`
	// ends the command; joining here would swallow the next command into it.
	test("does not join when the trailing backslash is itself escaped", () => {
		const pkg = ["```sh", "printf 'x' \\\\", "bun test extension", "```"].join(
			"\n",
		);
		expect(extractVerifyCommands(pkg)).toEqual([
			"printf 'x' \\\\",
			"bun test extension",
		]);
	});
});
