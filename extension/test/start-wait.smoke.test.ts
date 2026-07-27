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
import { workflowDispatch } from "../adapters/dispatch.ts";

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

/**
 * Point HOME at a throwaway dir holding a minimal global config.
 *
 * `workflow_start` loads the global config, so without this the suite passes
 * only on machines that happen to have a real `~/.config/apnea/config.json`
 * and fails everywhere else — it was green locally and red on CI for exactly
 * that reason. Returns a restore function.
 */
function fakeHomeWithConfig(): () => void {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-smoke-home-"));
	dirs.push(home);
	const cfgDir = path.join(home, ".config", "apnea");
	fs.mkdirSync(cfgDir, { recursive: true });
	fs.writeFileSync(
		path.join(cfgDir, "config.json"),
		`${JSON.stringify(
			{
				profiles: { smoke: { cmd_interactive: ["true"], cmd_oneshot: ["true"] } },
				roles: {
					planner: { profile: "smoke" },
					reviewer: { profile: "smoke" },
					coder: { profile: "smoke" },
				},
			},
			null,
			2,
		)}\n`,
	);

	const prevHome = process.env.HOME;
	const prevUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	return () => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevUserProfile;
	};
}

describe("workflow smoke", () => {
	test("start, status, double-start refuse, illegal commit", async () => {
		// This suite asserts the no-Herdr path; strip ambient HERDR_ENV from the
		// orchestrator pane so dispatch does not open live role panes mid-test.
		const prevHerdr = process.env.HERDR_ENV;
		delete process.env.HERDR_ENV;
		const restoreHome = fakeHomeWithConfig();
		const d = gitRepo();
		process.chdir(d);

		try {
			const s = await workflowStart({
				goal: "smoke test feature",
				slug: "smoke",
			});
			// Surface the refusal instead of a bare `false` — the reason is the
			// whole diagnostic when this breaks.
			expect(s.ok ? null : s.error).toBeNull();
			if (s.ok) expect(s.data?.state).toBeDefined();

			const st = await workflowStatus();
			expect(st.ok).toBe(true);

			const again = await workflowStart({ goal: "nope" });
			expect(again.ok).toBe(false);

			const commit = await workflowCommitPhase({});
			expect(commit.ok).toBe(false);

			// dispatch without herdr still writes task
			const disp = await workflowDispatch({ kind: "plan" });
			expect(disp.ok).toBe(true);
			if (disp.ok) {
				expect(fs.existsSync(path.join(d, String(disp.data?.task)))).toBe(true);
			}
		} finally {
			restoreHome();
			if (prevHerdr === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = prevHerdr;
		}
	});
});
