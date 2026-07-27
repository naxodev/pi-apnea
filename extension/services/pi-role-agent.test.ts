/**
 * No-vim pi agent dir for role panes. Pure filter + temp-dir materialize.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	filterPackagesNoVim,
	isPiCmd,
	isPiVimModePackage,
	materializePiRoleAgentDir,
	wrapInteractiveCmdNoVim,
} from "./pi-role-agent.ts";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-pi-role-"));
	tmpDirs.push(d);
	return d;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		throw new Error(
			`expected valid JSON at ${file}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

describe("isPiCmd / isPiVimModePackage", () => {
	// Wrong binary detection would either skip the no-vim wrap (coder stuck
	// in INSERT) or inject env into claude launches for no reason.
	test("detects pi binary by basename", () => {
		expect(isPiCmd(["pi"])).toBe(true);
		expect(isPiCmd(["/usr/local/bin/pi", "--provider", "x"])).toBe(true);
		expect(isPiCmd(["claude", "--model", "x"])).toBe(false);
		expect(isPiCmd([])).toBe(false);
		expect(isPiCmd(null)).toBe(false);
	});

	test("detects vimmode package forms", () => {
		expect(isPiVimModePackage("npm:pi-vimmode")).toBe(true);
		expect(isPiVimModePackage("npm:pi-lens")).toBe(false);
		expect(
			isPiVimModePackage({ source: "git:github.com/pekochan069/pi-vimmode" }),
		).toBe(true);
		expect(isPiVimModePackage({ source: "npm:pi-btw" })).toBe(false);
	});
});

describe("filterPackagesNoVim", () => {
	// Role panes must keep every other package; only vimmode is the hazard.
	test("strips vimmode string and object entries, keeps others", () => {
		const input = [
			"npm:pi-lens",
			"npm:pi-vimmode",
			{ source: "npm:pi-web-access" },
			{ source: "npm:pi-vimmode", extensions: [] },
			"../../work/1-projects/naxodev/pi-apnea",
		];
		expect(filterPackagesNoVim(input)).toEqual([
			"npm:pi-lens",
			{ source: "npm:pi-web-access" },
			"../../work/1-projects/naxodev/pi-apnea",
		]);
	});

	test("non-array → empty", () => {
		expect(filterPackagesNoVim(undefined)).toEqual([]);
		expect(filterPackagesNoVim("x")).toEqual([]);
	});
});

describe("materializePiRoleAgentDir", () => {
	// Materialize must produce a usable agent dir without pi-vimmode so
	// PI_CODING_AGENT_DIR launches never load modal vim.
	test("writes settings without vimmode and links auth", () => {
		const source = tmp();
		const dest = path.join(tmp(), "role-agent");
		fs.writeFileSync(
			path.join(source, "settings.json"),
			JSON.stringify({
				packages: ["npm:pi-lens", "npm:pi-vimmode", "npm:pi-btw"],
				piVimMode: { preset: "vim-heavy" },
				theme: "tokyo-night-moon",
			}),
			"utf8",
		);
		fs.writeFileSync(path.join(source, "auth.json"), '{"ok":true}\n', "utf8");
		fs.mkdirSync(path.join(source, "npm"));
		fs.writeFileSync(path.join(source, "npm", "marker"), "1", "utf8");

		const out = materializePiRoleAgentDir({
			sourceAgentDir: source,
			destDir: dest,
		});
		expect(out).toBe(dest);

		const settings = readJson(path.join(dest, "settings.json")) as {
			packages: unknown[];
			piVimMode?: unknown;
			theme?: string;
		};
		expect(settings.packages).toEqual(["npm:pi-lens", "npm:pi-btw"]);
		expect(settings.piVimMode).toBeUndefined();
		expect(settings.theme).toBe("tokyo-night-moon");

		// auth linked/copied
		expect(fs.existsSync(path.join(dest, "auth.json"))).toBe(true);
		expect(fs.readFileSync(path.join(dest, "auth.json"), "utf8")).toContain(
			"ok",
		);
		expect(fs.existsSync(path.join(dest, "npm", "marker"))).toBe(true);
	});

	test("idempotent refresh drops newly-added vimmode", () => {
		const source = tmp();
		const dest = path.join(tmp(), "role-agent");
		fs.writeFileSync(
			path.join(source, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-lens"] }),
			"utf8",
		);
		materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest });

		fs.writeFileSync(
			path.join(source, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-lens", "npm:pi-vimmode"] }),
			"utf8",
		);
		materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest });
		const settings = readJson(path.join(dest, "settings.json")) as {
			packages: unknown[];
		};
		expect(settings.packages).toEqual(["npm:pi-lens"]);
	});
});

describe("wrapInteractiveCmdNoVim", () => {
	// Non-pi cmds must not be rewritten — only pi needs the agent-dir env.
	test("wraps pi with env PI_CODING_AGENT_DIR; leaves claude alone", () => {
		const source = tmp();
		const dest = path.join(tmp(), "role-agent");
		fs.writeFileSync(
			path.join(source, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-vimmode", "npm:pi-lens"] }),
			"utf8",
		);

		expect(wrapInteractiveCmdNoVim(["claude", "--model", "x"])).toEqual([
			"claude",
			"--model",
			"x",
		]);

		const wrapped = wrapInteractiveCmdNoVim(["pi", "--provider", "grok-cli"], {
			sourceAgentDir: source,
			destDir: dest,
		});
		expect(wrapped).toEqual([
			"env",
			`PI_CODING_AGENT_DIR=${dest}`,
			"pi",
			"--provider",
			"grok-cli",
		]);
		const settings = readJson(path.join(dest, "settings.json")) as {
			packages: unknown[];
		};
		expect(settings.packages).toEqual(["npm:pi-lens"]);
	});
});
