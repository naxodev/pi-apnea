import { describe, expect, test } from "bun:test";
import { isCompleteArtifact, parseFrontMatter } from "./frontmatter.ts";

describe("parseFrontMatter", () => {
	test("parses status and verdict", () => {
		const fm = parseFrontMatter(`---
status: done
verdict: APPROVED
---

body here
`);
		expect(fm?.status).toBe("done");
		expect(fm?.verdict).toBe("APPROVED");
		expect(fm?.body.trim()).toBe("body here");
	});

	test("parses multiline nits", () => {
		const fm = parseFrontMatter(`---
status: done
verdict: APPROVED
nits: |
  line one
  line two
---

x
`);
		expect(fm?.nits).toContain("line one");
		expect(isCompleteArtifact(fm, { requireVerdict: true })).toBe(true);
	});

	test("rejects missing verdict when required", () => {
		const fm = parseFrontMatter(`---
status: done
---
`);
		expect(isCompleteArtifact(fm, { requireVerdict: true })).toBe(false);
		expect(isCompleteArtifact(fm)).toBe(true);
	});

	test("null without fence", () => {
		expect(parseFrontMatter("no fm")).toBeNull();
	});
});
