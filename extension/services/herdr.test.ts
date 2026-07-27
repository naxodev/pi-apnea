/**
 * Real HerdrLive, temp dir, no herdr CLI on PATH — only the file-based
 * floating-script surface is exercised here (pane/interactive methods need a
 * live herdr and are covered by the floating-dispatch smoke test instead).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Result } from "effect";
import {
	Herdr,
	HerdrLive,
	ensurePromptSubmitted,
	floatingPanePath,
	resolveExecutable,
} from "./herdr.ts";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-herdr-svc-"));
	tmpDirs.push(d);
	return d;
}

describe("HerdrLive.writeFloatingTaskScript", () => {
	// A mis-quoted or unresolved binary silently 127s inside a popup with a
	// stripped PATH — this must fail loud at dispatch time instead.
	test("resolves a bare binary via PATH, writes mode 0o755, and records the exit code when run", async () => {
		const d = tmp();
		const bin = path.join(d, "pi");
		fs.writeFileSync(bin, "#!/bin/sh\nexit 42\n");
		fs.chmodSync(bin, 0o755);

		const script = path.join(d, "task.sh");
		const exitFile = path.join(d, "task.exit");
		const prevPath = process.env.PATH;
		process.env.PATH = d;
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const herdr = yield* Herdr;
					yield* herdr.writeFloatingTaskScript(
						script,
						d,
						["pi", "-p"],
						"hi",
						exitFile,
					);
				}).pipe(Effect.provide(HerdrLive)),
			);
		} finally {
			process.env.PATH = prevPath;
		}

		const body = fs.readFileSync(script, "utf8");
		// bare `pi` must become an absolute path so popup PATH cannot 127 it
		expect(body).toContain(`${bin} -p `);
		expect(body).not.toMatch(/(?:^|\s)pi -p /);
		const mode = fs.statSync(script).mode & 0o777;
		expect(mode & 0o100).toBeTruthy(); // owner-executable

		const r = spawnSync("bash", [script], { encoding: "utf8" });
		expect(r.status).toBe(42);
		expect(fs.readFileSync(exitFile, "utf8").trim()).toBe("42");
	});

	test("missing binary → HerdrError, no file written", async () => {
		const d = tmp();
		const script = path.join(d, "task.sh");
		const exitFile = path.join(d, "task.exit");
		const prevPath = process.env.PATH;
		process.env.PATH = d; // empty of matching bins
		try {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const herdr = yield* Herdr;
					return yield* Effect.result(
						herdr.writeFloatingTaskScript(
							script,
							d,
							["no-such-harness"],
							"hi",
							exitFile,
						),
					);
				}).pipe(Effect.provide(HerdrLive)),
			);
			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result)) {
				expect(result.failure._tag).toBe("HerdrError");
				expect(result.failure.message).toMatch(
					/floating oneshot binary "no-such-harness" not found/,
				);
			}
		} finally {
			process.env.PATH = prevPath;
		}
		expect(fs.existsSync(script)).toBe(false);
	});
});

describe("resolveExecutable", () => {
	// Bare names must resolve in the orchestrator env before the popup PATH strips them.
	test("resolves absolute executable paths and rejects missing ones", () => {
		const d = tmp();
		const bin = path.join(d, "fake-claude");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		expect(resolveExecutable(bin)).toBe(bin);
		expect(resolveExecutable(path.join(d, "missing"))).toBeNull();
	});

	test("resolves bare names via PATH", () => {
		const d = tmp();
		const bin = path.join(d, "mytool");
		fs.writeFileSync(bin, "#!/bin/sh\n");
		fs.chmodSync(bin, 0o755);
		expect(resolveExecutable("mytool", d)).toBe(bin);
		expect(resolveExecutable("mytool", "/no/such/bin")).toBeNull();
	});
});

describe("ensurePromptSubmitted recovery", () => {
	/**
	 * Fake `herdr` where the pane is permanently idle and `send-keys` fails —
	 * i.e. the pane died (or the installed herdr predates the subcommand)
	 * between prompt submit and the recovery attempt.
	 */
	function fakeHerdrBin(dir: string): void {
		const bin = path.join(dir, "herdr");
		fs.writeFileSync(
			bin,
			[
				"#!/bin/sh",
				'case "$1 $2" in',
				'  "pane get") echo \'{"result":{"pane":{"pane_id":"p1","agent_status":"idle"}}}\' ;;',
				'  "pane send-keys") echo "pane is gone" >&2; exit 1 ;;',
				'  *) echo \'{"result":{}}\' ;;',
				"esac",
			].join("\n"),
		);
		fs.chmodSync(bin, 0o755);
	}

	// The `*Sync` helpers throw, and a throw inside Effect.gen is a *defect* —
	// Effect.ignore/Effect.option pass defects straight through. If recovery
	// dies here, dispatch_role aborts before `store.save`, so the role agent
	// runs with the prompt while the run has no pending_artifact: workflow_wait
	// then refuses and a re-dispatch renames the produced artifact to .bak.
	test("a dead pane during recovery reports accepted:false instead of dying", async () => {
		const d = tmp();
		fakeHerdrBin(d);
		const prevPath = process.env.PATH;
		const prevEnv = process.env.HERDR_ENV;
		process.env.PATH = d;
		process.env.HERDR_ENV = "1";
		try {
			const out = await Effect.runPromise(
				ensurePromptSubmitted("p1", "do the thing", {
					settleMs: 1,
					workingWaitMs: 1,
				}),
			);
			expect(out.accepted).toBe(false);
			expect(out.attempts).toBe(3);
		} finally {
			process.env.PATH = prevPath;
			if (prevEnv === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = prevEnv;
		}
	});
});

describe("floatingPanePath", () => {
	test("appends existing user-local bins without dropping base PATH", () => {
		const d = tmp();
		const localBin = path.join(d, ".local", "bin");
		fs.mkdirSync(localBin, { recursive: true });
		const out = floatingPanePath("/usr/bin:/bin", d);
		expect(out.startsWith("/usr/bin:/bin")).toBe(true);
		expect(out.split(path.delimiter)).toContain(localBin);
	});
});
