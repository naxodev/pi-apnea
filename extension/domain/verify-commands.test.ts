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

// One backslash, written without a literal so the escaping in these cases stays
// readable. Every string below is the exact text a planner would put in a fence.
const B = String.fromCharCode(92);
const fence = (body: string) => `## Verify commands\n\n\`\`\`sh\n${body}\n\`\`\``;

describe("extractVerifyCommands — line continuations", () => {
	// The gate splits the fence into commands and runs each one. Every case here
	// was reproduced against the first version of this parser, and three of them
	// made the gate report a phase VERIFIED without running its checks — worse
	// than the refusal the continuation support was added to fix.

	test("joins a continuation the way a shell does: no separator inserted", () => {
		// The first version substituted a single space. `over` + `view.md` then
		// became two arguments instead of one path.
		expect(extractVerifyCommands(fence(`test -f docs/over${B}\nview.md`))).toEqual([
			"test -f docs/overview.md",
		]);
	});

	test("preserves whitespace inside a continued quoted string", () => {
		// Collapsing to one space rewrites the pattern being searched for, so the
		// gate can report a pass for a check that never held.
		expect(
			extractVerifyCommands(fence(`grep -q 'foo ${B}\n   bar' README.md`)),
		).toEqual(["grep -q 'foo    bar' README.md"]);
	});

	test("does not let a commented line swallow the command below it", () => {
		// A shell comment ends at its physical line; the backslash in it continues
		// nothing. Joining before stripping comments merged the two and dropped
		// both, so `bun test extension` never ran and the phase committed green.
		expect(
			extractVerifyCommands(
				fence(`# smoke check ${B}\nbun test extension\nbunx tsc --noEmit`),
			),
		).toEqual(["bun test extension", "bunx tsc --noEmit"]);
	});

	test("treats a backslash followed by a space as an escaped space, not a continuation", () => {
		// Trailing whitespace after a backslash is a routine editor artifact. The
		// first version joined here and swallowed the next command as an argument
		// to `echo`, which exits 0 — suite unrun, gate green.
		expect(
			extractVerifyCommands(fence(`echo hi ${B} \nbun test extension`)),
		).toEqual([`echo hi ${B}`, "bun test extension"]);
	});

	test("removes only the final backslash of an odd run, leaving literals for the shell", () => {
		// Three backslashes are one escaped literal plus one continuation. The
		// first version dropped all of them, so an escaped pattern lost its escape
		// and a guard written to fail matched nothing and passed.
		expect(
			extractVerifyCommands(fence(`printf 'a'${B}${B}${B}\nbun test extension`)),
		).toEqual([`printf 'a'${B}${B}bun test extension`]);
	});

	test("an even backslash run ends the command", () => {
		expect(
			extractVerifyCommands(fence(`printf 'x' ${B}${B}\nbun test extension`)),
		).toEqual([`printf 'x' ${B}${B}`, "bun test extension"]);
	});

	test("joins a continuation spanning three lines", () => {
		expect(extractVerifyCommands(fence(`a ${B}\nb ${B}\nc`))).toEqual(["a b c"]);
	});

	// The fence paths were fixed and this one was not, so the original bug stayed
	// live wherever a package had no sh/bash fence.
	test("joins continuations on the non-fence fallback path too", () => {
		expect(
			extractVerifyCommands(`bun test extension ${B}\n --coverage`),
		).toEqual(["bun test extension  --coverage"]);
	});
});

describe("extractVerifyCommands — comments interleaved with continuations", () => {
	// Both split orderings shipped bugs: join-then-strip let a trailing-backslash
	// comment swallow the command below it; strip-then-join spliced the commands
	// on either side of a removed comment line into one. bash interleaves, and
	// every command later runs through `bash -lc`, so bash is the spec.
	test("a comment between a continued line and the next command does not splice them", () => {
		expect(
			extractVerifyCommands(
				fence(`test -f README.md ${B}\n# note about the check\nbun test extension`),
			),
		).toEqual(["test -f README.md", "bun test extension"]);
	});

	test("a comment with its own trailing backslash still ends the logical command", () => {
		// bash discards a comment to the end of the logical line, backslash and
		// all — the comment's continuation must not glue `next` onward.
		expect(
			extractVerifyCommands(
				fence(`test -f a ${B}\n# note ${B}\nbun test extension`),
			),
		).toEqual(["test -f a", "bun test extension"]);
	});

	test("a joined '#' with no whitespace on either side is a word, not a comment", () => {
		// `over\` + `#note` is the single word `over#note` in bash; terminating
		// on it would split one command into two.
		expect(extractVerifyCommands(fence(`test -f over${B}\n#note.md`))).toEqual([
			"test -f over#note.md",
		]);
	});
});

describe("extractVerifyCommands — no-fence path and markdown hard breaks", () => {
	// The no-fence text is markdown, not shell: a trailing backslash on a prose
	// line is a hard break. Joining document-wide glued prose onto the command
	// below it, the merged line stopped matching the command pattern, and the
	// check was silently dropped — the gate committed the phase green having run
	// a subset of its verify commands.
	test("a prose hard break above a command does not swallow it", () => {
		expect(
			extractVerifyCommands(
				`Some prose with a hard break ${B}\n$ bun test extension\n$ bunx tsc --noEmit`,
			),
		).toEqual(["bun test extension", "bunx tsc --noEmit"]);
	});
});
