/**
 * Pure helpers for floating-pane preflight. No Herdr required.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	effectivePaneStyle,
	parseHerdrVersion,
	supportsFloating,
	versionGte,
	writeFloatingTaskScript,
} from "./herdr.ts";
import type { Role } from "./types.ts";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

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

describe("writeFloatingTaskScript", () => {
	// A mis-quoted prompt silently truncates the role's instructions.
	test("writes executable script with shebang, cd, and quoted prompt", () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-float-"));
		tmpDirs.push(d);
		const script = path.join(d, "task.sh");
		const root = "/tmp/project with spaces";
		const prompt = "line1\nline2's quote";
		writeFloatingTaskScript(script, root, ["pi", "-p"], prompt);

		const body = fs.readFileSync(script, "utf8");
		expect(body.startsWith("#!/usr/bin/env bash\n")).toBe(true);
		expect(body).toContain("set -euo pipefail\n");
		expect(body).toContain(`cd '${root}'`);
		expect(body).toMatch(/exec pi -p /);
		// prompt must appear as a single-quoted argv (shellJoin escaping)
		expect(body).toContain(`'${prompt.replace(/'/g, `'\\''`)}'`);

		const mode = fs.statSync(script).mode & 0o777;
		expect(mode & 0o100).toBeTruthy(); // owner-executable
	});
});
