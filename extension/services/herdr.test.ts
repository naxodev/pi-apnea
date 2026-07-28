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
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { HerdrError } from "../errors.ts";
import {
	Herdr,
	HerdrLive,
	type PromptProbes,
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
	 * Fake probes whose reported status flips on *observed events* — a `sendKeys`
	 * or a `run` — not on a poll count or a timer. Each ladder rung is defined by
	 * "working only after X", so that is what the fake keys on.
	 */
	function fakeProbes(opts: {
		workingAfter: "start" | "sendKeys" | "rerun" | "never";
		sendKeysFails?: boolean;
	}) {
		const rec = { keys: [] as string[][], runs: [] as string[] };
		let sawSendKeys = false;
		let runCount = 0;
		const probes: PromptProbes = {
			status: () => {
				switch (opts.workingAfter) {
					case "start":
						return "working";
					case "sendKeys":
						return sawSendKeys ? "working" : "idle";
					case "rerun":
						return runCount > 0 ? "working" : "idle";
					case "never":
						return "idle";
				}
			},
			sendKeys: (keys) =>
				opts.sendKeysFails
					? Effect.fail(new HerdrError({ message: "pane is gone" }))
					: Effect.sync(() => {
							rec.keys.push(keys);
							sawSendKeys = true;
						}),
			run: (text) =>
				Effect.sync(() => {
					rec.runs.push(text);
					runCount += 1;
				}),
		};
		return { probes, rec };
	}

	/**
	 * Run the ladder in virtual time. Production timings (2.5s settle, 12s
	 * windows) then cost nothing, so the test exercises the real thresholds.
	 */
	function drive(
		eff: Effect.Effect<{ accepted: boolean; attempts: number; last_status?: string }>,
	) {
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(eff);
			yield* TestClock.adjust(120_000);
			return yield* Fiber.join(fiber);
		}).pipe(Effect.provide(TestClock.layer()));
	}

	test("accepted immediately: status is working from the start", async () => {
		const { probes } = fakeProbes({ workingAfter: "start" });
		const out = await Effect.runPromise(
			drive(ensurePromptSubmitted("p1", "go", { probes })),
		);
		expect(out).toEqual({ accepted: true, attempts: 1, last_status: "working" });
	});

	test("Escape/Enter recovery: idle until sendKeys, no re-submit", async () => {
		const { probes, rec } = fakeProbes({ workingAfter: "sendKeys" });
		const out = await Effect.runPromise(
			drive(ensurePromptSubmitted("p1", "go", { probes })),
		);
		expect(out.attempts).toBe(2);
		expect(out.accepted).toBe(true);
		expect(rec.keys).toEqual([["Escape"], ["Enter"]]);
		expect(rec.runs).toEqual([]);
	});

	test("full re-submit: idle until run, Escape/Enter then Escape+run", async () => {
		const { probes, rec } = fakeProbes({ workingAfter: "rerun" });
		const out = await Effect.runPromise(
			drive(ensurePromptSubmitted("p1", "go", { probes })),
		);
		expect(out.attempts).toBe(3);
		expect(out.accepted).toBe(true);
		expect(rec.runs).toEqual(["go"]);
		expect(rec.keys).toEqual([["Escape"], ["Enter"], ["Escape"]]);
	});

	test("never accepted: pane stays idle through the whole ladder", async () => {
		const { probes } = fakeProbes({ workingAfter: "never" });
		const out = await Effect.runPromise(
			drive(ensurePromptSubmitted("p1", "go", { probes })),
		);
		expect(out).toEqual({ accepted: false, attempts: 3, last_status: "idle" });
	});

	// The `*Sync` helpers throw, and a throw inside Effect.gen is a *defect* —
	// Effect.ignore/Effect.option pass defects straight through. If recovery
	// dies here, dispatch_role aborts before `store.save`, so the role agent
	// runs with the prompt while the run has no pending_artifact: workflow_wait
	// then refuses and a re-dispatch renames the produced artifact to .bak.
	test("a dead pane during recovery reports accepted:false instead of dying", async () => {
		const { probes, rec } = fakeProbes({
			workingAfter: "never",
			sendKeysFails: true,
		});
		const out = await Effect.runPromise(
			drive(ensurePromptSubmitted("p1", "do the thing", { probes })),
		);
		expect(out.accepted).toBe(false);
		expect(out.attempts).toBe(3);
		expect(rec.runs).toEqual([]);
	});
});

describe("clock purity", () => {
	// Deadlines paired with Effect.sleep must read the Clock: a wall-clock
	// deadline never elapses under TestClock, so the loop would hang instead
	// of failing loudly. waitAgentReady is not otherwise reachable in tests.
	test("herdr.ts has no Date.now() deadlines", () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "herdr.ts"), "utf8");
		const code = src
			.split("\n")
			.filter((line) => {
				const t = line.trim();
				return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
			})
			.join("\n");
		expect(code).not.toContain("Date.now(");
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
