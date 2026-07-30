/**
 * Smoke: run the built `dist/cli.js` binary as a real subprocess.
 *
 * Every other test in this project calls functions directly. This file is
 * the only end-to-end coverage that a shell invoking the bundled artifact
 * actually works — argv parsing, exit codes, and (critically) the
 * `reset-rounds` TTY gate, which only behaves correctly when stdin/stdout
 * are real pipes rather than an injected fake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLI = new URL("../../dist/cli.js", import.meta.url).pathname;

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

/** Fresh temp dir with an initialized git repo. Tracked for cleanup. */
async function makeTempRepo(): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-cli-smoke-"));
	dirs.push(dir);
	Bun.spawnSync(["git", "init"], { cwd: dir });
	return dir;
}

async function run(args: string[], cwd: string) {
	const proc = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, stdout, stderr };
}

describe("apnea CLI", () => {
	test("status in a repo with no run exits 0", async () => {
		const dir = await makeTempRepo();
		const r = await run(["status"], dir);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("no active run");
	});

	test("unknown command exits 2 with usage", async () => {
		// Distinct from exit 1: a typo is the caller's bug, not a refused
		// transition, and an agent should retry differently.
		const dir = await makeTempRepo();
		const r = await run(["frobnicate"], dir);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("unknown command");
	});

	test("--json emits a parseable ToolResult", async () => {
		const dir = await makeTempRepo();
		const r = await run(["status", "--json"], dir);
		const parsed = JSON.parse(r.stdout);
		expect(parsed.ok).toBe(true);
	});

	test("reset-rounds refuses without a TTY", async () => {
		// Bun.spawn gives the child pipes, which is exactly the shape an agent's
		// shell tool produces. This is the end-to-end proof of the gate.
		const dir = await makeTempRepo();
		const r = await run(["reset-rounds", "plan_review"], dir);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("--i-am-human");
	});
});
