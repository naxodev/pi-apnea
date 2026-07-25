/**
 * Smoke: start → refuse double start; status; illegal commit.
 * Runs in a temp git repo without Herdr.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workflowStart } from "../adapters/start.ts";
import { workflowStatus } from "../adapters/status.ts";
import { workflowCommitPhase } from "../adapters/commit.ts";
import { workflowDispatch } from "./dispatch.ts";

const dirs: string[] = [];
const origCwd = process.cwd();

afterEach(() => {
	process.chdir(origCwd);
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function gitRepo(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-smoke-"));
	dirs.push(d);
	spawnSync("git", ["init"], { cwd: d });
	spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: d });
	spawnSync("git", ["config", "user.name", "t"], { cwd: d });
	fs.writeFileSync(path.join(d, "README"), "x\n");
	spawnSync("git", ["add", "."], { cwd: d });
	spawnSync("git", ["commit", "-m", "init"], { cwd: d });
	return d;
}

describe("workflow smoke", () => {
	test("start, status, double-start refuse, illegal commit", async () => {
		// This suite asserts the no-Herdr path; strip ambient HERDR_ENV from the
		// orchestrator pane so dispatch does not open live role panes mid-test.
		const prevHerdr = process.env.HERDR_ENV;
		delete process.env.HERDR_ENV;
		const d = gitRepo();
		process.chdir(d);

		try {
			const s = await workflowStart({
				goal: "smoke test feature",
				slug: "smoke",
			});
			expect(s.ok).toBe(true);
			if (s.ok) expect(s.data?.state).toBeDefined();

			const st = await workflowStatus();
			expect(st.ok).toBe(true);

			const again = await workflowStart({ goal: "nope" });
			expect(again.ok).toBe(false);

			const commit = await workflowCommitPhase({});
			expect(commit.ok).toBe(false);

			// dispatch without herdr still writes task
			const disp = workflowDispatch({ kind: "plan" });
			expect(disp.ok).toBe(true);
			if (disp.ok) {
				expect(fs.existsSync(path.join(d, String(disp.data?.task)))).toBe(true);
			}
		} finally {
			if (prevHerdr === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = prevHerdr;
		}
	});
});
