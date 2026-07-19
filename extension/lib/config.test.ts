import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyProject, loadConfig, parseGlobal } from "./config.ts";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs) {
		fs.rmSync(d, { recursive: true, force: true });
	}
	tmpDirs.length = 0;
});

function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-cfg-"));
	tmpDirs.push(d);
	return d;
}

describe("loadConfig trust", () => {
	test("rejects project cmd", () => {
		const root = tmp();
		const g = path.join(os.homedir(), ".config", "apnea", "config.json");
		// use real global if present; skip if not
		if (!fs.existsSync(g)) return;
		fs.mkdirSync(path.join(root, ".apnea"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".apnea", "config.json"),
			JSON.stringify({
				roles: { coder: { profile: "pi-grok", cmd: ["evil"] } },
			}),
		);
		expect(() => loadConfig(root)).toThrow(/must not set cmd/);
	});

	test("rejects project profiles key", () => {
		const root = tmp();
		const g = path.join(os.homedir(), ".config", "apnea", "config.json");
		if (!fs.existsSync(g)) return;
		fs.mkdirSync(path.join(root, ".apnea"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".apnea", "config.json"),
			JSON.stringify({ profiles: { x: { cmd_oneshot: ["x"] } } }),
		);
		expect(() => loadConfig(root)).toThrow(/must not set profiles/);
	});
});

const baseGlobal = {
	profiles: { p: { cmd_oneshot: ["x"], cmd_interactive: ["x"] } },
	roles: {
		planner: { profile: "p" },
		reviewer: { profile: "p" },
		coder: { profile: "p" },
	},
};

describe("pane_style", () => {
	// Existing users who never heard of this key must see zero behavior change.
	test("omitted everywhere defaults to regular", () => {
		expect(applyProject(parseGlobal(baseGlobal), null).pane_style).toBe(
			"regular",
		);
	});

	test("global floating is respected", () => {
		expect(
			parseGlobal({ ...baseGlobal, pane_style: "floating" }).pane_style,
		).toBe("floating");
	});

	// Project UX preference must win over global in both directions.
	test("project override wins both directions", () => {
		const fromRegular = applyProject(
			parseGlobal({ ...baseGlobal, pane_style: "regular" }),
			{ pane_style: "floating" },
		);
		expect(fromRegular.pane_style).toBe("floating");

		const fromFloating = applyProject(
			parseGlobal({ ...baseGlobal, pane_style: "floating" }),
			{ pane_style: "regular" },
		);
		expect(fromFloating.pane_style).toBe("regular");
	});

	// An unrelated project config must not silently reset the preference.
	test("project silent on the key inherits global", () => {
		const cfg = parseGlobal({ ...baseGlobal, pane_style: "floating" });
		expect(applyProject(cfg, {}).pane_style).toBe("floating");
		expect(applyProject(cfg, { review_round_cap: 2 }).pane_style).toBe(
			"floating",
		);
	});

	// Orchestrator runs unattended — a typo must fail at config load, not mid-run.
	test("invalid value throws naming key and allowed values", () => {
		const re = /pane_style.*"regular" or "floating"/;
		expect(() => parseGlobal({ ...baseGlobal, pane_style: "tiled" })).toThrow(
			re,
		);
		expect(() =>
			applyProject(parseGlobal(baseGlobal), { pane_style: "tiled" }),
		).toThrow(re);
		expect(() => parseGlobal({ ...baseGlobal, pane_style: true })).toThrow(re);
	});

	// pane_style is a UX preference, not a forbidden project key.
	test("project pane_style is not rejected as unknown", () => {
		expect(() =>
			applyProject(parseGlobal(baseGlobal), { pane_style: "floating" }),
		).not.toThrow(/unknown project config key/);
	});
});
