/**
 * provisionHerdrPlugin + pane_style preservation. Never touches real home
 * or spawns herdr — all deps are injected fakes / temp dirs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preservePaneStyle, provisionHerdrPlugin } from "./setup.ts";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
	tmpDirs.length = 0;
});

function makeSrcPlugin(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-plugin-src-"));
	tmpDirs.push(d);
	fs.mkdirSync(path.join(d, "scripts"), { recursive: true });
	fs.writeFileSync(
		path.join(d, "herdr-plugin.toml"),
		'id = "apnea"\nname = "Apnea"\n',
		"utf8",
	);
	fs.writeFileSync(
		path.join(d, "scripts", "run-task.sh"),
		"#!/usr/bin/env bash\nexit 0\n",
		"utf8",
	);
	// intentionally non-exec so the provisioner must chmod
	fs.chmodSync(path.join(d, "scripts", "run-task.sh"), 0o644);
	return d;
}

function makeDestParent(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-plugin-dest-"));
	tmpDirs.push(d);
	return d;
}

describe("provisionHerdrPlugin", () => {
	// Fresh install must produce a ready-to-link tree with an executable worker.
	test("fresh copy: dest populated, exec bit set, linked when herdr >= 0.7.4", () => {
		const src = makeSrcPlugin();
		const dest = path.join(makeDestParent(), "herdr-plugin");
		let linkCalls = 0;
		const result = provisionHerdrPlugin({
			srcDir: src,
			destDir: dest,
			version: [0, 7, 4],
			hasPlugin: () => false,
			link: (dir) => {
				linkCalls += 1;
				expect(dir).toBe(dest);
				return { ok: true, raw: "linked" };
			},
		});

		expect(result.copied).toBe(dest);
		expect(result.linked).toBe(true);
		expect(result.already_linked).toBe(false);
		expect(result.notes).toEqual([]);
		expect(linkCalls).toBe(1);
		expect(fs.existsSync(path.join(dest, "herdr-plugin.toml"))).toBe(true);
		const mode =
			fs.statSync(path.join(dest, "scripts", "run-task.sh")).mode & 0o777;
		expect(mode & 0o100).toBeTruthy();
	});

	// Re-running setup must refresh package files without re-linking (duplicate link can error).
	test("idempotent re-run: re-copies but skips link when already linked", () => {
		const src = makeSrcPlugin();
		const dest = path.join(makeDestParent(), "herdr-plugin");
		// first call establishes dest
		provisionHerdrPlugin({
			srcDir: src,
			destDir: dest,
			version: [0, 7, 4],
			hasPlugin: () => false,
			link: () => ({ ok: true, raw: "ok" }),
		});
		// simulate a stale package file that an update would refresh
		fs.writeFileSync(
			path.join(dest, "herdr-plugin.toml"),
			'id = "apnea"\nstale = true\n',
			"utf8",
		);
		fs.writeFileSync(
			path.join(src, "herdr-plugin.toml"),
			'id = "apnea"\nversion = "0.1.1"\n',
			"utf8",
		);

		let linkCalls = 0;
		const result = provisionHerdrPlugin({
			srcDir: src,
			destDir: dest,
			version: [0, 7, 4],
			hasPlugin: () => true,
			link: () => {
				linkCalls += 1;
				return { ok: true, raw: "should-not-run" };
			},
		});

		expect(result.copied).toBe(dest);
		expect(result.linked).toBe(false);
		expect(result.already_linked).toBe(true);
		expect(linkCalls).toBe(0);
		// re-copy refreshed the package file from src
		const body = fs.readFileSync(path.join(dest, "herdr-plugin.toml"), "utf8");
		expect(body).toContain("0.1.1");
		expect(body).not.toContain("stale");
	});

	// Linking on 0.7.3 hard-fails at manifest parse; the note is how operators discover the upgrade.
	test("old herdr [0,7,3]: no link attempt, note names 0.7.4 and herdr update", () => {
		const src = makeSrcPlugin();
		const dest = path.join(makeDestParent(), "herdr-plugin");
		let linkCalls = 0;
		const result = provisionHerdrPlugin({
			srcDir: src,
			destDir: dest,
			version: [0, 7, 3],
			hasPlugin: () => false,
			link: () => {
				linkCalls += 1;
				return { ok: true, raw: "nope" };
			},
		});

		expect(result.copied).toBe(dest);
		expect(result.linked).toBe(false);
		expect(result.already_linked).toBe(false);
		expect(linkCalls).toBe(0);
		expect(result.notes.length).toBe(1);
		expect(result.notes[0]).toContain("0.7.4");
		expect(result.notes[0]).toContain("herdr update");
		expect(result.notes[0]).toContain("0.7.3");
	});

	// Missing package content must be actionable, not a crash mid-setup.
	test("missing srcDir: copied null, actionable note, no throw", () => {
		const dest = path.join(makeDestParent(), "herdr-plugin");
		const result = provisionHerdrPlugin({
			srcDir: path.join(os.tmpdir(), "apnea-no-such-plugin-src"),
			destDir: dest,
			version: [0, 7, 4],
			hasPlugin: () => false,
			link: () => ({ ok: true, raw: "" }),
		});

		expect(result.copied).toBeNull();
		expect(result.linked).toBe(false);
		expect(result.already_linked).toBe(false);
		expect(result.notes.some((n) => n.includes("reinstall"))).toBe(true);
	});

	// A capability provisioning failure must not brick setup for regular-pane users.
	test("link failure: linked false, note carries raw, no throw", () => {
		const src = makeSrcPlugin();
		const dest = path.join(makeDestParent(), "herdr-plugin");
		const result = provisionHerdrPlugin({
			srcDir: src,
			destDir: dest,
			version: [0, 7, 4],
			hasPlugin: () => false,
			link: () => ({ ok: false, raw: "placement popup rejected" }),
		});

		expect(result.copied).toBe(dest);
		expect(result.linked).toBe(false);
		expect(result.already_linked).toBe(false);
		expect(
			result.notes.some((n) => n.includes("placement popup rejected")),
		).toBe(true);
	});
});

describe("preservePaneStyle", () => {
	// Setup must never silently drop a user's floating opt-in on re-run (or --force).
	test("prev floating/regular survive; absent stays absent; invalid dropped", () => {
		expect(preservePaneStyle({ pane_style: "floating" })).toBe("floating");
		expect(preservePaneStyle({ pane_style: "regular" })).toBe("regular");
		expect(preservePaneStyle({})).toBeUndefined();
		expect(preservePaneStyle({ pane_style: "tiled" })).toBeUndefined();
		expect(preservePaneStyle({ pane_style: 1 })).toBeUndefined();
	});
});
