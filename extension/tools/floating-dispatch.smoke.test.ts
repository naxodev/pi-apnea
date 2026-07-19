/**
 * Smoke: floating dispatch preflight.
 * Skipped unless HERDR_ENV=1 (inside Herdr). Encodes that misconfiguration
 * fails at dispatch with an actionable message instead of hanging a wait.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseHerdrVersion, supportsFloating } from "../lib/herdr.ts";
import { requireState } from "../lib/state.ts";
import { workflowDispatch } from "./dispatch.ts";
import { workflowStart } from "./start.ts";

const dirs: string[] = [];
const origCwd = process.cwd();
const insideHerdr = process.env.HERDR_ENV === "1";

afterEach(() => {
	process.chdir(origCwd);
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function gitRepo(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-float-smoke-"));
	dirs.push(d);
	spawnSync("git", ["init"], { cwd: d });
	spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: d });
	spawnSync("git", ["config", "user.name", "t"], { cwd: d });
	fs.writeFileSync(path.join(d, "README"), "x\n");
	spawnSync("git", ["add", "."], { cwd: d });
	spawnSync("git", ["commit", "-m", "init"], { cwd: d });
	return d;
}

describe("floating dispatch smoke", () => {
	test.skipIf(!insideHerdr)(
		"floating plan dispatch preflight matches environment",
		() => {
			const d = gitRepo();
			process.chdir(d);

			const s = workflowStart({
				goal: "floating smoke",
				slug: "float-smoke",
				allow_dirty: true,
			});
			expect(s.ok).toBe(true);

			fs.mkdirSync(path.join(d, ".apnea"), { recursive: true });
			fs.writeFileSync(
				path.join(d, ".apnea", "config.json"),
				JSON.stringify({ pane_style: "floating" }),
			);

			const disp = workflowDispatch({ kind: "plan" });
			const verRaw = spawnSync("herdr", ["--version"], { encoding: "utf8" });
			const version = parseHerdrVersion(
				`${verRaw.stdout ?? ""}${verRaw.stderr ?? ""}`,
			);
			const floatingOk = supportsFloating(version);

			if (!floatingOk) {
				// herdr < 0.7.4 must fail fast with the exact actionable message
				expect(disp.ok).toBe(false);
				if (!disp.ok) {
					expect(disp.error).toBe(
						"floating panes need herdr >= 0.7.4 — run `herdr update`, or set pane_style=regular",
					);
				}
				return;
			}

			// herdr ≥ 0.7.4: either plugin-missing error, or a successful floating launch
			if (!disp.ok) {
				expect(disp.error).toMatch(
					/apnea herdr plugin not linked|cmd_oneshot|herdr plugin pane open failed/,
				);
				return;
			}

			expect(disp.data?.launch).toMatchObject({
				pane_style_effective: "floating",
			});
			const state = requireState(d);
			expect(state.pending_pane_id).toBeNull();
			expect(state.role_panes.planner).toBeUndefined();
		},
	);
});
