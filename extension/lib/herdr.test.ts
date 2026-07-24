/**
 * Pure helpers for floating-pane preflight. No Herdr required.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
	effectivePaneStyle,
	floatingPanePath,
	parseHerdrVersion,
	readFloatingExit,
	resolveExecutable,
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

describe("resolveExecutable", () => {
	// Bare names must resolve in the orchestrator env before the popup PATH strips them.
	test("resolves absolute executable paths and rejects missing ones", () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-bin-"));
		tmpDirs.push(d);
		const bin = path.join(d, "fake-claude");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		expect(resolveExecutable(bin)).toBe(bin);
		expect(resolveExecutable(path.join(d, "missing"))).toBeNull();
	});

	test("resolves bare names via PATH", () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-path-"));
		tmpDirs.push(d);
		const bin = path.join(d, "mytool");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		expect(resolveExecutable("mytool", d)).toBe(bin);
		expect(resolveExecutable("mytool", "/no/such/bin")).toBeNull();
	});
});

describe("floatingPanePath", () => {
	test("appends existing user-local bins without dropping base PATH", () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-fpp-"));
		tmpDirs.push(d);
		const localBin = path.join(d, ".local", "bin");
		fs.mkdirSync(localBin, { recursive: true });
		const out = floatingPanePath("/usr/bin:/bin", d);
		expect(out.startsWith("/usr/bin:/bin")).toBe(true);
		expect(out.split(path.delimiter)).toContain(localBin);
	});
});

describe("writeFloatingTaskScript", () => {
	// A mis-quoted prompt silently truncates the role's instructions.
	test("writes executable script with shebang, cd, absolute binary, exit trap, and quoted prompt", () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-float-"));
		tmpDirs.push(d);
		const bin = path.join(d, "pi");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);

		const script = path.join(d, "task.sh");
		const exitFile = path.join(d, "task.exit");
		const root = "/tmp/project with spaces";
		const prompt = "line1\nline2's quote";
		const prevPath = process.env.PATH;
		process.env.PATH = d;
		try {
			writeFloatingTaskScript(script, root, ["pi", "-p"], prompt, exitFile);
		} finally {
			process.env.PATH = prevPath;
		}

		const body = fs.readFileSync(script, "utf8");
		expect(body.startsWith("#!/bin/bash\n")).toBe(true);
		expect(body).toContain("set -uo pipefail\n");
		expect(body).toContain(`cd '${root}'`);
		// bare `pi` must become an absolute path so popup PATH cannot 127 it
		expect(body).toContain(`${bin} -p `);
		expect(body).not.toMatch(/(?:^|\s)pi -p /);
		// end-of-options so variadic CLI flags cannot eat the prompt
		expect(body).toContain(" -- ");
		// no bare exec — EXIT trap must outlive the oneshot
		expect(body).not.toMatch(/\bexec\b/);
		expect(body).toContain("trap write_exit EXIT");
		expect(body).toContain(`EXIT_FILE=${exitFile}`);
		// prompt must appear as a single-quoted argv (shellJoin escaping)
		expect(body).toContain(`'${prompt.replace(/'/g, `'\\''`)}'`);

		const mode = fs.statSync(script).mode & 0o777;
		expect(mode & 0o100).toBeTruthy(); // owner-executable
	});

	test("records exit code when the oneshot process ends", () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-float-run-"));
		tmpDirs.push(d);
		const bin = path.join(d, "pi");
		fs.writeFileSync(bin, "#!/bin/sh\nexit 42\n");
		fs.chmodSync(bin, 0o755);
		const script = path.join(d, "task.sh");
		const exitFile = path.join(d, "task.exit");
		const prevPath = process.env.PATH;
		process.env.PATH = d;
		try {
			writeFloatingTaskScript(script, d, ["pi", "-p"], "hi", exitFile);
		} finally {
			process.env.PATH = prevPath;
		}
		const r = spawnSync("bash", [script], { encoding: "utf8" });
		expect(r.status).toBe(42);
		expect(readFloatingExit(exitFile)).toBe(42);
	});

	test("fails closed when oneshot binary is missing", () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-float-miss-"));
		tmpDirs.push(d);
		const script = path.join(d, "task.sh");
		const exitFile = path.join(d, "task.exit");
		const prevPath = process.env.PATH;
		process.env.PATH = d; // empty of matching bins
		try {
			expect(() =>
				writeFloatingTaskScript(
					script,
					d,
					["no-such-harness"],
					"hi",
					exitFile,
				),
			).toThrow(/floating oneshot binary "no-such-harness" not found/);
		} finally {
			process.env.PATH = prevPath;
		}
		expect(fs.existsSync(script)).toBe(false);
	});
});
