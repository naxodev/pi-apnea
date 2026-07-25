/**
 * Temp-dir integration tests for start/status/reset workflows (real AppLive).
 * Interim config/vcs still hit the real FS — needs a git repo + global config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workflowStart } from "../adapters/start.ts";
import {
	workflowResetRounds,
	workflowStatus,
} from "../adapters/status.ts";

const dirs: string[] = [];
const origCwd = process.cwd();

afterEach(() => {
	process.chdir(origCwd);
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function gitRepo(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-wf-"));
	dirs.push(d);
	spawnSync("git", ["init"], { cwd: d });
	spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: d });
	spawnSync("git", ["config", "user.name", "t"], { cwd: d });
	fs.writeFileSync(path.join(d, "README"), "x\n");
	spawnSync("git", ["add", "."], { cwd: d });
	spawnSync("git", ["commit", "-m", "init"], { cwd: d });
	return d;
}

function hasGlobalConfig(): boolean {
	const g = path.join(os.homedir(), ".config", "apnea", "config.json");
	return fs.existsSync(g);
}

describe("start/status/reset workflows (temp dir)", () => {
	test("status with no state → ok has_state:false", async () => {
		const d = gitRepo();
		process.chdir(d);
		const st = await workflowStatus();
		expect(st.ok).toBe(true);
		if (st.ok) expect(st.data?.has_state).toBe(false);
	});

	test("reset-rounds on missing state → ok:false no-run-state", async () => {
		const d = gitRepo();
		process.chdir(d);
		const r = await workflowResetRounds({ gate: "plan_review" });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/no run state/i);
			expect(r.legal_next).toContain("workflow_start");
		}
	});

	test("start, double-start, abandon, resume", async () => {
		if (!hasGlobalConfig()) return; // skip when no profiles (CI bare)
		const d = gitRepo();
		process.chdir(d);

		const s = await workflowStart({
			goal: "workflow temp test",
			slug: "wf-temp",
		});
		expect(s.ok).toBe(true);
		if (s.ok) {
			expect(s.message).toContain("started run");
			expect(s.data?.next).toBe("dispatch_role");
			expect(s.data?.next_args).toEqual({ kind: "plan" });
			expect(s.data?.legal_next).toEqual([
				"dispatch_role",
				"workflow_status",
			]);
			expect(s.data?.note).toContain("does not launch roles");
			expect(s.data?.state).toBeDefined();
		}

		const again = await workflowStart({ goal: "nope" });
		expect(again.ok).toBe(false);
		if (!again.ok) {
			expect(again.error).toContain("already exists");
			expect(again.data?.step).toBe("planning");
			expect(again.data?.slug).toBe("wf-temp");
		}

		const st = await workflowStatus();
		expect(st.ok).toBe(true);
		if (st.ok) expect(st.data?.has_state).not.toBe(false);

		const resume = await workflowStart({ goal: "", action: "resume" });
		expect(resume.ok).toBe(true);
		if (resume.ok) {
			expect(resume.message).toContain("do not auto-dispatch");
			expect(resume.data?.state).toBeDefined();
			expect(resume.data?.pending_status).toBe("none");
			expect(resume.data?.hint).toBeDefined();
		}

		const abandoned = await workflowStart({ goal: "", action: "abandon" });
		expect(abandoned.ok).toBe(true);
		if (abandoned.ok) {
			expect(abandoned.data?.backup).toBeDefined();
			expect(String(abandoned.data?.backup)).toContain("abandoned");
		}
		expect(fs.existsSync(path.join(d, ".apnea", "state.json"))).toBe(false);
	});

	test("dirty tree refusal + allow_dirty override", async () => {
		if (!hasGlobalConfig()) return;
		const d = gitRepo();
		// make dirty
		fs.writeFileSync(path.join(d, "dirty.txt"), "y\n");
		process.chdir(d);

		const refused = await workflowStart({ goal: "dirty", slug: "dirty" });
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.error).toMatch(/dirty/i);
		}

		const ok = await workflowStart({
			goal: "dirty",
			slug: "dirty-ok",
			allow_dirty: true,
		});
		expect(ok.ok).toBe(true);
	});

	test("corrupt state.json → StateCorrupt message", async () => {
		const d = gitRepo();
		fs.mkdirSync(path.join(d, ".apnea"), { recursive: true });
		fs.writeFileSync(path.join(d, ".apnea", "state.json"), "{bad");
		process.chdir(d);

		const st = await workflowStatus();
		expect(st.ok).toBe(false);
		if (!st.ok) expect(st.error).toContain("corrupt state");

		const start = await workflowStart({ goal: "x", action: "resume" });
		expect(start.ok).toBe(false);
		if (!start.ok) expect(start.error).toContain("corrupt state");
	});

	test("reset-rounds zeros counter", async () => {
		if (!hasGlobalConfig()) return;
		const d = gitRepo();
		process.chdir(d);
		const s = await workflowStart({ goal: "reset test", slug: "rst" });
		expect(s.ok).toBe(true);

		// seed rounds via direct write
		const p = path.join(d, ".apnea", "state.json");
		const raw = JSON.parse(fs.readFileSync(p, "utf8"));
		raw.rounds = { plan_review: 3 };
		fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);

		const r = await workflowResetRounds({ gate: "plan_review" });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.message).toContain("3 → 1");
		const after = JSON.parse(fs.readFileSync(p, "utf8"));
		expect(after.rounds.plan_review).toBe(1);
	});
});
