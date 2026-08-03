import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
	PACKAGE_NAME,
	findPackageRootFrom,
	globalConfigPath,
	packageRoot,
} from "./paths.ts";

describe("globalConfigPath", () => {
	test("follows HOME when set", () => {
		const prev = process.env.HOME;
		process.env.HOME = "/tmp/apnea-home";
		try {
			expect(globalConfigPath()).toBe(
				path.join("/tmp/apnea-home", ".config", "apnea", "config.json"),
			);
		} finally {
			if (prev === undefined) delete process.env.HOME;
			else process.env.HOME = prev;
		}
	});

	// An env-only lookup returns "" without HOME (launchd/systemd/`env -i`),
	// making this path cwd-relative — i.e. the *project repo* would be read as
	// the trusted global config, the one place profiles/cmd_interactive are
	// honoured. A cloned repo could then spawn its own cmd_interactive.
	test("stays absolute when HOME and USERPROFILE are both unset", () => {
		const home = process.env.HOME;
		const userProfile = process.env.USERPROFILE;
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		try {
			const p = globalConfigPath();
			expect(path.isAbsolute(p)).toBe(true);
			expect(p.startsWith(path.join(process.cwd(), ".config"))).toBe(false);
		} finally {
			if (home !== undefined) process.env.HOME = home;
			if (userProfile !== undefined) process.env.USERPROFILE = userProfile;
		}
	});
});

describe("packageRoot", () => {
	// `dispatch` builds every brief path from this. A wrong answer is silent:
	// the pane still launches, and the role sits there having been told to read
	// a file that does not exist. That is exactly what shipped — the old
	// implementation counted two directories up, which is right for
	// `extension/domain/paths.ts` and wrong for the bundled `dist/cli.js`, so
	// the CLI resolved this repo's PARENT. No test caught it because the
	// workflow tests fake this function and the Pi extension loads from source.
	test("points at the directory that actually holds briefs/", () => {
		const root = packageRoot();
		expect(path.isAbsolute(root)).toBe(true);
		expect(fs.existsSync(path.join(root, "briefs", "planner.md"))).toBe(true);
		expect(fs.existsSync(path.join(root, "herdr-plugin"))).toBe(true);
	});

	// The bundle layout is the one that broke, and it is the one
	// `packageRoot()` alone cannot exercise: run from source, two-levels-up and
	// the manifest search agree, so a test that just calls `packageRoot()`
	// passes against the bug. These drive the layout instead.
	function tree(): { dir: string; cleanup: () => void } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-root-"));
		return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
	}

	test("resolves one level up from dist/, where the bundled CLI lives", () => {
		const { dir, cleanup } = tree();
		try {
			const pkg = path.join(dir, "pi-apnea");
			fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
			fs.writeFileSync(
				path.join(pkg, "package.json"),
				JSON.stringify({ name: PACKAGE_NAME }),
			);
			// Two levels up from dist/ is `dir` — the repo's parent. That is the
			// value the CLI actually shipped, and every brief path it printed
			// pointed there.
			expect(findPackageRootFrom(path.join(pkg, "dist"))).toBe(pkg);
		} finally {
			cleanup();
		}
	});

	// The name check earns its place only here. Walking up from `dist/`, our own
	// package.json is normally the first one found, so "stop at any manifest"
	// and "stop at ours" agree — until a build writes a manifest INTO dist/,
	// which "publish from dist" setups do. Then the first-match rule stops one
	// directory too early and briefs/ resolves inside the build output.
	test("ignores a foreign package.json sitting inside dist/", () => {
		const { dir, cleanup } = tree();
		try {
			const pkg = path.join(dir, "pi-apnea");
			const dist = path.join(pkg, "dist");
			fs.mkdirSync(dist, { recursive: true });
			fs.writeFileSync(
				path.join(pkg, "package.json"),
				JSON.stringify({ name: PACKAGE_NAME }),
			);
			fs.writeFileSync(
				path.join(dist, "package.json"),
				JSON.stringify({ name: "apnea-dist-artifact" }),
			);
			expect(findPackageRootFrom(dist)).toBe(pkg);
		} finally {
			cleanup();
		}
	});

	test("skips the consumer's package.json when installed as a dependency", () => {
		const { dir, cleanup } = tree();
		try {
			const self = path.join(dir, "node_modules", "@naxodev", "apnea");
			fs.mkdirSync(path.join(self, "dist"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "some-consumer" }),
			);
			fs.writeFileSync(
				path.join(self, "package.json"),
				JSON.stringify({ name: PACKAGE_NAME }),
			);
			// Stopping at the first package.json found would return `dir` and send
			// briefs/ and herdr-plugin/ into the consumer's own project.
			expect(findPackageRootFrom(path.join(self, "dist"))).toBe(self);
		} finally {
			cleanup();
		}
	});
});
