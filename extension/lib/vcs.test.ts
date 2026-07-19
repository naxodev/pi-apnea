import { describe, expect, test } from "bun:test";
import { extractVerifyCommands } from "./vcs.ts";

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
