import * as path from "node:path";
import { Effect, Result } from "effect";
import { supportsFloating } from "../domain/herdr.ts";
import { globalConfigPath, packageRoot, projectConfigPath } from "../domain/paths.ts";
import {
	buildGlobalConfig,
	detectionNotes,
	pickRoles,
	type Detected,
} from "../domain/setup.ts";
import { ConfigError, type AppError } from "../errors.ts";
import { ok, type ToolResult } from "../result.ts";
import { decodeGlobalConfig } from "../schema/config.ts";
import { FileSystem } from "../services/file-system.ts";
import { Herdr } from "../services/herdr.ts";

export type SetupParams = {
	/** Write .apnea/config.json role bindings in cwd */
	project?: boolean;
	/** Overwrite existing global profiles (default: merge, keep existing profile keys) */
	force?: boolean;
};

export type SetupDeps = {
	/** Detect an executable on PATH (production: `which`). */
	onPath: (bin: string) => boolean;
	/** Build the no-vim pi agent dir; may throw (production: materializePiRoleAgentDir). */
	materializeRoleAgentDir: () => string;
};

export type ProvisionResult = {
	copied: string | null; // dest dir, or null when skipped
	linked: boolean; // true only when we ran `herdr plugin link` OK
	already_linked: boolean;
	notes: string[];
};

/**
 * Copy the package's herdr-plugin into a stable config-local path and, when
 * herdr is new enough and the plugin isn't already linked, run
 * `herdr plugin link`. Never fails — every branch is a note.
 */
export const provisionHerdrPlugin = (opts: {
	srcDir: string; // packageRoot()/herdr-plugin
	destDir: string; // dirname(globalConfigPath())/herdr-plugin
	version: [number, number, number] | null; // herdr.version
}): Effect.Effect<ProvisionResult, never, FileSystem | Herdr> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const herdr = yield* Herdr;
		const notes: string[] = [];

		const srcExists = yield* fs.exists(opts.srcDir);
		if (!srcExists) {
			notes.push("herdr-plugin missing from package — reinstall @naxodev/apnea");
			return { copied: null, linked: false, already_linked: false, notes };
		}

		yield* fs.copyDir(opts.srcDir, opts.destDir);
		const runTask = path.join(opts.destDir, "scripts", "run-task.sh");
		if (yield* fs.exists(runTask)) {
			yield* fs.chmod(runTask, 0o755);
		}

		if (!supportsFloating(opts.version)) {
			const ver =
				opts.version == null
					? "unknown"
					: `${opts.version[0]}.${opts.version[1]}.${opts.version[2]}`;
			notes.push(
				`herdr ${ver} < 0.7.4 — floating panes unavailable; run \`herdr update\`, then re-run /apnea setup`,
			);
			return { copied: opts.destDir, linked: false, already_linked: false, notes };
		}

		if (yield* herdr.hasApneaPlugin) {
			return { copied: opts.destDir, linked: false, already_linked: true, notes };
		}

		const linkResult = yield* herdr.linkPlugin(opts.destDir);
		if (!linkResult.ok) {
			notes.push(
				`herdr plugin link failed: ${linkResult.raw.trim() || "(no output)"}`,
			);
			return { copied: opts.destDir, linked: false, already_linked: false, notes };
		}

		return { copied: opts.destDir, linked: true, already_linked: false, notes };
	});

/**
 * Deterministic Apnea setup: detect binaries, write global profiles
 * (and optional project role bindings). Never writes cmd into project config.
 */
export const setupWorkflow = (
	params: SetupParams,
	root: string,
	deps: SetupDeps,
): Effect.Effect<ToolResult, AppError, FileSystem | Herdr> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const herdr = yield* Herdr;

		const readJsonSafe = (
			filePath: string,
		): Effect.Effect<Record<string, unknown>> =>
			Effect.gen(function* () {
				const present = yield* fs.exists(filePath);
				if (!present) return {};
				const text = yield* fs.readFile(filePath);
				try {
					const v = JSON.parse(text);
					if (v && typeof v === "object" && !Array.isArray(v)) {
						return v as Record<string, unknown>;
					}
					return {};
				} catch {
					return {};
				}
			});

		const has: Detected = {
			pi: deps.onPath("pi"),
			claude: deps.onPath("claude"),
			codex: deps.onPath("codex"),
			herdr: deps.onPath("herdr"),
			jj: deps.onPath("jj"),
			git: deps.onPath("git"),
		};

		if (!has.pi) {
			return yield* new ConfigError({
				message: "pi not on PATH — install pi before apnea setup",
			});
		}

		const gPath = globalConfigPath();
		yield* fs.mkdir(path.dirname(gPath), { recursive: true });

		const prev = yield* readJsonSafe(gPath);
		const force = params.force === true;
		const globalConfig = buildGlobalConfig({ has, prev, force });

		const serialized = `${JSON.stringify(globalConfig, null, 2)}\n`;
		yield* fs.writeFile(gPath, serialized);

		let projectPath: string | null = null;
		if (params.project) {
			const pPath = projectConfigPath(root);
			yield* fs.mkdir(path.dirname(pPath), { recursive: true });
			// project: roles only — never cmd
			const projectCfg = { roles: pickRoles(has) };
			yield* fs.writeFile(pPath, `${JSON.stringify(projectCfg, null, 2)}\n`);
			projectPath = pPath;
		}

		const missing = detectionNotes(has);

		// Pre-build the no-vim pi agent dir so first dispatch is fast.
		let piRoleAgentDir: string | null = null;
		const materialized = yield* Effect.result(
			Effect.try({ try: deps.materializeRoleAgentDir, catch: (e) => e }),
		);
		if (Result.isSuccess(materialized)) {
			piRoleAgentDir = materialized.success;
		} else {
			const e = materialized.failure;
			missing.push(
				`pi role agent dir failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}

		let herdrPlugin: ProvisionResult | null = null;
		let herdrVer: string | null = null;
		if (has.herdr) {
			const version = yield* herdr.version;
			herdrVer =
				version == null ? null : `${version[0]}.${version[1]}.${version[2]}`;
			herdrPlugin = yield* provisionHerdrPlugin({
				srcDir: path.join(packageRoot(), "herdr-plugin"),
				destDir: path.join(path.dirname(globalConfigPath()), "herdr-plugin"),
				version,
			});
			missing.push(...herdrPlugin.notes);
		}

		// A failed decode after writing is a note, not a failure — a user with a
		// malformed pre-existing config must still get a written config and an
		// actionable note, never a hard refusal where today there is none.
		const decoded = decodeGlobalConfig(globalConfig);
		if (Result.isFailure(decoded)) {
			missing.push(
				`global config written but does not validate: ${decoded.failure.message}`,
			);
		}

		const data: Record<string, unknown> = {
			global: gPath,
			project: projectPath,
			detected: has,
			roles: globalConfig.roles,
			notes: missing,
			pi_role_agent_dir: piRoleAgentDir,
			next: "edit ~/.config/apnea/config.json if model ids differ, then /apnea start <goal> inside Herdr",
		};
		if (has.herdr) {
			data.herdr_version = herdrVer;
			data.herdr_plugin = herdrPlugin
				? {
						copied: herdrPlugin.copied,
						linked: herdrPlugin.linked,
						already_linked: herdrPlugin.already_linked,
					}
				: null;
		}

		return ok(`wrote global config ${gPath}`, data);
	});
