import { describe, expect, test } from "bun:test";
import { DISPATCH_KINDS } from "../domain/state-machine.ts";
import { buildParams } from "./main.ts";
import { parseFlags } from "./parse.ts";

/** Runs argv through the same tokenizer the CLI uses before handing off to
 * `buildParams`, so these tests exercise the real flag/positional split. */
function build(verb: string, action: string | null, argv: string[]) {
	const { flags, values, rest } = parseFlags(argv);
	return buildParams(verb, action, flags, values, rest);
}

describe("buildParams: argument shape per verb", () => {
	test("setup", () => {
		expect(build("setup", null, ["--project", "--force", "--agents-md"])).toEqual({
			ok: true,
			params: { project: true, force: true, agents_md: true },
		});
	});

	test("start", () => {
		expect(
			build("start", null, ["fix", "the", "bug", "--slug=my-run", "--allow-dirty"]),
		).toEqual({
			ok: true,
			params: { action: "start", goal: "fix the bug", slug: "my-run", allow_dirty: true },
		});
	});

	test("dispatch", () => {
		const kind = DISPATCH_KINDS[0];
		expect(build("dispatch", null, [kind, "--rework"])).toEqual({
			ok: true,
			params: { kind, rework: true },
		});
	});

	test("wait", () => {
		expect(build("wait", null, ["--poll=1000", "--budget=200000"])).toEqual({
			ok: true,
			params: { poll_ms: 1000, budget_ms: 200000 },
		});
	});

	test("commit", () => {
		expect(build("commit", null, ["--done", "wrap", "up"])).toEqual({
			ok: true,
			params: { message: "wrap up", no_remaining_phases: true },
		});
	});

	test("status takes no arguments", () => {
		expect(build("status", null, [])).toEqual({ ok: true, params: {} });
	});

	test("reset-rounds", () => {
		expect(build("reset-rounds", null, ["plan_review"])).toEqual({
			ok: true,
			params: { gate: "plan_review" },
		});
	});
});

describe("resume/abandon route to the start operation", () => {
	// main() looks up findByVerb("start") for both, then passes the literal
	// verb through as `action` — this is the seam that makes that translation
	// correct instead of accidentally re-running a fresh `start`.
	test("resume", () => {
		expect(build("start", "resume", ["ignored", "positional"])).toEqual({
			ok: true,
			params: { action: "resume" },
		});
	});

	test("abandon", () => {
		expect(build("start", "abandon", [])).toEqual({
			ok: true,
			params: { action: "abandon" },
		});
	});
});

describe("missing required positional refuses instead of guessing", () => {
	test("start with no goal", () => {
		expect(build("start", null, ["--allow-dirty"]).ok).toBe(false);
	});

	test("dispatch with no kind", () => {
		expect(build("dispatch", null, []).ok).toBe(false);
	});

	test("dispatch with an unknown kind", () => {
		expect(build("dispatch", null, ["not-a-kind"]).ok).toBe(false);
	});

	test("reset-rounds with no gate", () => {
		expect(build("reset-rounds", null, []).ok).toBe(false);
	});
});

describe("wait: --timeout is an alias for --budget", () => {
	test("timeout alone sets budget_ms", () => {
		expect(build("wait", null, ["--timeout=60000"])).toEqual({
			ok: true,
			params: { poll_ms: undefined, budget_ms: 60000 },
		});
	});

	// budget_ms: num("budget") ?? num("timeout") — budget wins when both are
	// given. If this ever flipped, a caller migrating from --timeout to
	// --budget mid-script would get silently overridden by a stale --timeout.
	test("budget takes precedence over timeout when both are given", () => {
		expect(build("wait", null, ["--budget=1000", "--timeout=2000"])).toEqual({
			ok: true,
			params: { poll_ms: undefined, budget_ms: 1000 },
		});
	});
});

describe("wait: an invalid numeric flag is refused, not silently defaulted", () => {
	// `apnea wait --budget=abc` used to fall back to the default budget and
	// exit 0/3 as though nothing were wrong. A scripting agent needs a signal
	// on its own typo, not a quietly-wrong value.
	test("invalid --budget names the flag and the bad value", () => {
		const r = build("wait", null, ["--budget=abc"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("--budget=abc");
	});

	test("invalid --poll names the flag and the bad value", () => {
		const r = build("wait", null, ["--poll=nope"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("--poll=nope");
	});

	test("invalid --timeout names the flag and the bad value", () => {
		const r = build("wait", null, ["--timeout=soon"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("--timeout=soon");
	});

	// `--budget=` (no value) means "forgot to pass one", not "budget of zero
	// milliseconds" — a 0ms budget would be indistinguishable from a typo but
	// behave very differently (the wait workflow would refuse it outright).
	test("empty --budget= is treated as not provided, not as zero", () => {
		expect(build("wait", null, ["--budget="])).toEqual({
			ok: true,
			params: { poll_ms: undefined, budget_ms: undefined },
		});
	});
});
