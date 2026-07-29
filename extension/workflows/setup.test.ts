import { afterEach, describe, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { globalConfigPath, packageRoot, projectConfigPath } from "../domain/paths.ts";
import { toToolResult } from "../errors.ts";
import { FileSystemLive } from "../services/file-system.ts";
import { expectFailure } from "../test/expect-failure.ts";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { fakeHerdrLayer, type FakeHerdrOptions } from "../test/fake-herdr.ts";
import { itEffect } from "../test/it-effect.ts";
import {
	provisionHerdrPlugin,
	setupWorkflow,
	type SetupDeps,
} from "./setup.ts";

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

function provisionLayer(opts: FakeHerdrOptions = {}) {
	const herdr = fakeHerdrLayer(opts);
	return {
		layer: Layer.merge(FileSystemLive, herdr.layer),
		recorder: herdr.recorder,
	};
}

describe("provisionHerdrPlugin (real fs + fake Herdr)", () => {
	// Fresh install must produce a ready-to-link tree with an executable worker.
	itEffect("fresh copy: dest populated, exec bit set, linked when herdr >= 0.7.4", () => {
		const src = makeSrcPlugin();
		const dest = path.join(makeDestParent(), "herdr-plugin");
		const { layer, recorder } = provisionLayer({ hasPlugin: false });
		return Effect.gen(function* () {
			const result = yield* provisionHerdrPlugin({
				srcDir: src,
				destDir: dest,
				version: [0, 7, 4],
			});
			expect(result.copied).toBe(dest);
			expect(result.linked).toBe(true);
			expect(result.already_linked).toBe(false);
			expect(result.notes).toEqual([]);
			expect(recorder.linkedPlugins).toEqual([dest]);
			expect(fs.existsSync(path.join(dest, "herdr-plugin.toml"))).toBe(true);
			const mode =
				fs.statSync(path.join(dest, "scripts", "run-task.sh")).mode & 0o777;
			expect(mode & 0o100).toBeTruthy();
		}).pipe(Effect.provide(layer));
	});

	// Re-running setup must refresh package files without re-linking (duplicate link can error).
	itEffect("idempotent re-run: re-copies but skips link when already linked", () => {
		const src = makeSrcPlugin();
		const dest = path.join(makeDestParent(), "herdr-plugin");
		return Effect.gen(function* () {
			yield* provisionHerdrPlugin({
				srcDir: src,
				destDir: dest,
				version: [0, 7, 4],
			}).pipe(Effect.provide(provisionLayer({ hasPlugin: false }).layer));

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

			const { layer, recorder } = provisionLayer({ hasPlugin: true });
			const result = yield* provisionHerdrPlugin({
				srcDir: src,
				destDir: dest,
				version: [0, 7, 4],
			}).pipe(Effect.provide(layer));

			expect(result.copied).toBe(dest);
			expect(result.linked).toBe(false);
			expect(result.already_linked).toBe(true);
			expect(recorder.linkedPlugins).toEqual([]);
			// re-copy refreshed the package file from src
			const body = fs.readFileSync(path.join(dest, "herdr-plugin.toml"), "utf8");
			expect(body).toContain("0.1.1");
			expect(body).not.toContain("stale");
		});
	});

	// Linking on 0.7.3 hard-fails at manifest parse; the note is how operators discover the upgrade.
	itEffect("old herdr [0,7,3]: no link attempt, note names 0.7.4 and herdr update", () => {
		const src = makeSrcPlugin();
		const dest = path.join(makeDestParent(), "herdr-plugin");
		const { layer, recorder } = provisionLayer({ hasPlugin: false });
		return Effect.gen(function* () {
			const result = yield* provisionHerdrPlugin({
				srcDir: src,
				destDir: dest,
				version: [0, 7, 3],
			});
			expect(result.copied).toBe(dest);
			expect(result.linked).toBe(false);
			expect(result.already_linked).toBe(false);
			expect(recorder.linkedPlugins).toEqual([]);
			expect(result.notes.length).toBe(1);
			expect(result.notes[0]).toContain("0.7.4");
			expect(result.notes[0]).toContain("herdr update");
			expect(result.notes[0]).toContain("0.7.3");
		}).pipe(Effect.provide(layer));
	});

	// Missing package content must be actionable, not a crash mid-setup.
	itEffect("missing srcDir: copied null, actionable note, no throw", () => {
		const dest = path.join(makeDestParent(), "herdr-plugin");
		const { layer } = provisionLayer({ hasPlugin: false });
		return Effect.gen(function* () {
			const result = yield* provisionHerdrPlugin({
				srcDir: path.join(os.tmpdir(), "apnea-no-such-plugin-src"),
				destDir: dest,
				version: [0, 7, 4],
			});
			expect(result.copied).toBeNull();
			expect(result.linked).toBe(false);
			expect(result.already_linked).toBe(false);
			expect(result.notes.some((n) => n.includes("reinstall"))).toBe(true);
		}).pipe(Effect.provide(layer));
	});

	// A capability provisioning failure must not brick setup for regular-pane users.
	itEffect("link failure: linked false, note carries raw, no throw", () => {
		const src = makeSrcPlugin();
		const dest = path.join(makeDestParent(), "herdr-plugin");
		const { layer } = provisionLayer({
			hasPlugin: false,
			linkResult: { ok: false, raw: "placement popup rejected" },
		});
		return Effect.gen(function* () {
			const result = yield* provisionHerdrPlugin({
				srcDir: src,
				destDir: dest,
				version: [0, 7, 4],
			});
			expect(result.copied).toBe(dest);
			expect(result.linked).toBe(false);
			expect(result.already_linked).toBe(false);
			expect(
				result.notes.some((n) => n.includes("placement popup rejected")),
			).toBe(true);
		}).pipe(Effect.provide(layer));
	});
});

const ROOT = "/proj";

function fakeDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
	return {
		onPath: () => true,
		materializeRoleAgentDir: () => "/fake/agent-dir",
		...overrides,
	};
}

function onPathFrom(bins: Record<string, boolean>): (bin: string) => boolean {
	return (bin) => bins[bin] ?? false;
}

function workflowLayer(
	fakeFs: ReturnType<typeof makeFakeFileSystem>,
	herdrOpts: FakeHerdrOptions = {},
) {
	const herdr = fakeHerdrLayer(herdrOpts);
	return { layer: Layer.merge(fakeFs.layer, herdr.layer), herdr: herdr.recorder };
}

const PLUGIN_SRC = path.join(packageRoot(), "herdr-plugin");
const PLUGIN_DEST = path.join(path.dirname(globalConfigPath()), "herdr-plugin");

/** Seed the package's plugin dir into the fake FS so provisioning can copy it. */
function seedPluginSrc(): Record<string, string> {
	return {
		[path.join(PLUGIN_SRC, "herdr-plugin.toml")]: 'id = "apnea"\n',
		[path.join(PLUGIN_SRC, "scripts", "run-task.sh")]:
			"#!/usr/bin/env bash\nexit 0\n",
	};
}

describe("setupWorkflow (fake FileSystem + fake Herdr)", () => {
	itEffect(
		"pi missing → ConfigError with the frozen message; writes nothing",
		() => {
			const fsFake = makeFakeFileSystem();
			const { layer } = workflowLayer(fsFake);
			const deps = fakeDeps({ onPath: onPathFrom({}) });
			return Effect.gen(function* () {
				const r = yield* Effect.result(setupWorkflow({}, ROOT, deps));
				const e = expectFailure(r, "ConfigError");
				expect(e.message).toBe(
					"pi not on PATH — install pi before apnea setup",
				);
				// A refusal that half-writes a config would be worse than the refusal.
				expect(fsFake.files.size).toBe(0);
				// Neither path nor details set here — toToolResult must still yield
				// data: undefined rather than an empty object.
				expect(toToolResult(e).data).toBeUndefined();
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"happy path: global config written with trailing newline; detected reflects deps.onPath; exact payload keys",
		() => {
			const fsFake = makeFakeFileSystem();
			const { layer } = workflowLayer(fsFake);
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true, claude: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(Object.keys(result.data ?? {}).sort()).toEqual(
						[
							"global",
							"project",
							"detected",
							"roles",
							"notes",
							"pi_role_agent_dir",
							"next",
						].sort(),
					);
					expect(result.data?.detected).toEqual({
						pi: true,
						claude: true,
						codex: false,
						herdr: false,
						jj: false,
						git: false,
					});
				}
				const gPath = globalConfigPath();
				expect(fsFake.files.get(gPath)?.endsWith("\n")).toBe(true);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"project:true writes .apnea/config.json with roles only — no cmd/profiles (the config trust model is the whole point of the split)",
		() => {
			const fsFake = makeFakeFileSystem();
			const { layer } = workflowLayer(fsFake);
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({ project: true }, ROOT, deps);
				expect(result.ok).toBe(true);
				const pPath = projectConfigPath(ROOT);
				if (result.ok) expect(result.data?.project).toBe(pPath);
				const body = fsFake.files.get(pPath);
				expect(body).toBeDefined();
				const parsed = JSON.parse(body!);
				expect(Object.keys(parsed)).toEqual(["roles"]);
				expect(parsed.roles.coder).toEqual({ profile: "pi-grok" });
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect("project omitted: no project file written, project:null", () => {
		const fsFake = makeFakeFileSystem();
		const { layer } = workflowLayer(fsFake);
		const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) });
		return Effect.gen(function* () {
			const result = yield* setupWorkflow({}, ROOT, deps);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.data?.project).toBeNull();
			expect(fsFake.files.has(projectConfigPath(ROOT))).toBe(false);
		}).pipe(Effect.provide(layer));
	});

	itEffect(
		"pre-existing config without force keeps the custom profile and preserves floating pane_style",
		() => {
			const gPath = globalConfigPath();
			const prevConfig = {
				profiles: { custom: { cmd_interactive: ["custom"] } },
				roles: { coder: { profile: "custom" } },
				pane_style: "floating",
			};
			const fsFake = makeFakeFileSystem({ [gPath]: JSON.stringify(prevConfig) });
			const { layer } = workflowLayer(fsFake);
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				const written = JSON.parse(fsFake.files.get(gPath)!);
				expect(written.profiles.custom).toBeDefined();
				expect(written.roles).toEqual({ coder: { profile: "custom" } });
				expect(written.pane_style).toBe("floating");
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"force:true replaces profiles/roles but the pane_style opt-in still survives",
		() => {
			const gPath = globalConfigPath();
			const prevConfig = {
				profiles: { custom: { cmd_interactive: ["custom"] } },
				roles: { coder: { profile: "custom" } },
				pane_style: "floating",
			};
			const fsFake = makeFakeFileSystem({ [gPath]: JSON.stringify(prevConfig) });
			const { layer } = workflowLayer(fsFake);
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({ force: true }, ROOT, deps);
				expect(result.ok).toBe(true);
				const written = JSON.parse(fsFake.files.get(gPath)!);
				expect(written.profiles.custom).toBeUndefined();
				expect(written.roles).toEqual({
					orchestrator: { profile: "pi-grok" },
					planner: { profile: "pi-default" },
					reviewer: { profile: "pi-default" },
					coder: { profile: "pi-grok" },
				});
				expect(written.pane_style).toBe("floating");
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"malformed pre-existing config JSON is treated as absent; setup still succeeds",
		() => {
			const gPath = globalConfigPath();
			const fsFake = makeFakeFileSystem({ [gPath]: "{not json" });
			const { layer } = workflowLayer(fsFake);
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				const written = JSON.parse(fsFake.files.get(gPath)!);
				expect(written.roles).toEqual({
					orchestrator: { profile: "pi-grok" },
					planner: { profile: "pi-default" },
					reviewer: { profile: "pi-default" },
					coder: { profile: "pi-grok" },
				});
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"materializeRoleAgentDir throwing → pi_role_agent_dir:null + note; setup still ok (a broken agent dir must not brick setup)",
		() => {
			const fsFake = makeFakeFileSystem();
			const { layer } = workflowLayer(fsFake);
			const deps = fakeDeps({
				onPath: onPathFrom({ pi: true }),
				materializeRoleAgentDir: () => {
					throw new Error("boom");
				},
			});
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.pi_role_agent_dir).toBeNull();
					expect(result.data?.notes).toContain("pi role agent dir failed: boom");
				}
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"herdr absent: no herdr_version/herdr_plugin keys, no Herdr calls recorded",
		() => {
			const fsFake = makeFakeFileSystem();
			const { layer, herdr } = workflowLayer(fsFake);
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect("herdr_version" in (result.data ?? {})).toBe(false);
					expect("herdr_plugin" in (result.data ?? {})).toBe(false);
				}
				expect(herdr.linkedPlugins).toEqual([]);
				expect(herdr.scripts).toEqual([]);
				expect(herdr.openedPanes).toEqual([]);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"herdr present, modern, plugin not yet linked: herdr_version/herdr_plugin payload keys, copy + link performed",
		() => {
			const fsFake = makeFakeFileSystem(seedPluginSrc());
			const { layer, herdr } = workflowLayer(fsFake, {
				version: [0, 7, 4],
				hasPlugin: false,
			});
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true, herdr: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.herdr_version).toBe("0.7.4");
					expect(result.data?.herdr_plugin).toEqual({
						copied: PLUGIN_DEST,
						linked: true,
						already_linked: false,
					});
					expect(Object.keys(result.data ?? {}).sort()).toEqual(
						[
							"global",
							"project",
							"detected",
							"roles",
							"notes",
							"pi_role_agent_dir",
							"next",
							"herdr_version",
							"herdr_plugin",
						].sort(),
					);
					const notes = (result.data?.notes ?? []) as string[];
					expect(
						notes.some(
							(n) =>
								n.includes("herdr-plugin missing") ||
								n.includes("< 0.7.4") ||
								n.includes("link failed"),
						),
					).toBe(false);
				}
				expect(herdr.linkedPlugins).toEqual([PLUGIN_DEST]);
				expect(fsFake.files.has(path.join(PLUGIN_DEST, "herdr-plugin.toml"))).toBe(
					true,
				);
				expect(
					fsFake.modes.get(path.join(PLUGIN_DEST, "scripts", "run-task.sh")),
				).toBe(0o755);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"herdr present, too old: herdr_plugin copied but not linked, note names 0.7.4/herdr update/0.7.3",
		() => {
			const fsFake = makeFakeFileSystem(seedPluginSrc());
			const { layer, herdr } = workflowLayer(fsFake, {
				version: [0, 7, 3],
				hasPlugin: false,
			});
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true, herdr: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.herdr_version).toBe("0.7.3");
					expect(result.data?.herdr_plugin).toMatchObject({
						copied: PLUGIN_DEST,
						linked: false,
						already_linked: false,
					});
					const notes = (result.data?.notes ?? []) as string[];
					const pluginNote = notes.find((n) => n.includes("0.7.4"));
					expect(pluginNote).toBeDefined();
					expect(pluginNote).toContain("herdr update");
					expect(pluginNote).toContain("0.7.3");
				}
				expect(herdr.linkedPlugins).toEqual([]);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"herdr present, plugin already linked: already_linked true, no re-link",
		() => {
			const fsFake = makeFakeFileSystem(seedPluginSrc());
			const { layer, herdr } = workflowLayer(fsFake, {
				version: [0, 7, 4],
				hasPlugin: true,
			});
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true, herdr: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.herdr_plugin).toMatchObject({
						already_linked: true,
						linked: false,
					});
				}
				expect(herdr.linkedPlugins).toEqual([]);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"herdr present, version unknown: herdr_version null, treated as sub-0.7.4",
		() => {
			const fsFake = makeFakeFileSystem(seedPluginSrc());
			const { layer, herdr } = workflowLayer(fsFake, {
				version: null,
				hasPlugin: false,
			});
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true, herdr: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.herdr_version).toBeNull();
					expect(result.data?.herdr_plugin).toMatchObject({ linked: false });
					const notes = (result.data?.notes ?? []) as string[];
					expect(notes.some((n) => n.includes("unknown"))).toBe(true);
				}
				expect(herdr.linkedPlugins).toEqual([]);
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"herdr present, plugin source missing from the package: copied null, reinstall note",
		() => {
			const fsFake = makeFakeFileSystem();
			const { layer } = workflowLayer(fsFake, {
				version: [0, 7, 4],
				hasPlugin: false,
			});
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true, herdr: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data?.herdr_plugin).toMatchObject({ copied: null });
					const notes = (result.data?.notes ?? []) as string[];
					expect(notes.some((n) => n.includes("reinstall"))).toBe(true);
				}
			}).pipe(Effect.provide(layer));
		},
	);

	itEffect(
		"prev.roles malformed without force → still ok, with the validation note present",
		() => {
			const gPath = globalConfigPath();
			// missing required "profile" — decodeGlobalConfig must reject this
			const prevConfig = { roles: { coder: {} } };
			const fsFake = makeFakeFileSystem({ [gPath]: JSON.stringify(prevConfig) });
			const { layer } = workflowLayer(fsFake);
			const deps = fakeDeps({ onPath: onPathFrom({ pi: true }) });
			return Effect.gen(function* () {
				const result = yield* setupWorkflow({}, ROOT, deps);
				expect(result.ok).toBe(true);
				if (result.ok) {
					const notes = (result.data?.notes ?? []) as string[];
					expect(notes.some((n) => n.includes("does not validate"))).toBe(true);
				}
			}).pipe(Effect.provide(layer));
		},
	);
});
