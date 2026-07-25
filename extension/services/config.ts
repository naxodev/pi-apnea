import { Context, Effect, Layer, Result } from "effect";
import { globalConfigPath, projectConfigPath } from "../domain/paths.ts";
import { ConfigError } from "../errors.ts";
import {
	ROLE_MODE,
	type ApneaConfig,
	type Role,
	type RoleMode,
} from "../lib/types.ts";
import {
	applyProjectConfig,
	decodeGlobalConfig,
	decodeProjectConfig,
	validateRoleBindings,
} from "../schema/config.ts";
import { FileSystem } from "./file-system.ts";

export interface ConfigService {
	readonly load: (root: string) => Effect.Effect<ApneaConfig, ConfigError>;
	readonly resolveRoleCmd: (
		cfg: ApneaConfig,
		role: Role,
		mode?: RoleMode,
	) => Effect.Effect<string[], ConfigError>;
}

export class Config extends Context.Service<Config, ConfigService>()(
	"apnea/Config",
) {}

function parseJson(
	text: string,
	filePath: string,
): Effect.Effect<unknown, ConfigError> {
	return Effect.try({
		try: () => JSON.parse(text) as unknown,
		catch: (e) =>
			new ConfigError({
				message: `invalid JSON at ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
				path: filePath,
			}),
	});
}

export const ConfigLive = Layer.effect(
	Config,
	Effect.gen(function* () {
		const fs = yield* FileSystem;

		const load = (root: string): Effect.Effect<ApneaConfig, ConfigError> =>
			Effect.gen(function* () {
				const gPath = globalConfigPath();
				const gPresent = yield* fs.exists(gPath);
				if (!gPresent) {
					return yield* new ConfigError({
						message: `missing global config at ${gPath}. Run apnea-setup / create profiles there.`,
						path: gPath,
					});
				}
				const gText = yield* fs.readFile(gPath);
				const gRaw = yield* parseJson(gText, gPath);
				const gDecoded = decodeGlobalConfig(gRaw);
				if (Result.isFailure(gDecoded)) {
					return yield* gDecoded.failure;
				}
				let cfg = gDecoded.success;

				const pPath = projectConfigPath(root);
				const pPresent = yield* fs.exists(pPath);
				if (pPresent) {
					const pText = yield* fs.readFile(pPath);
					const pRaw = yield* parseJson(pText, pPath);
					const pDecoded = decodeProjectConfig(pRaw);
					if (Result.isFailure(pDecoded)) {
						return yield* pDecoded.failure;
					}
					cfg = applyProjectConfig(cfg, pDecoded.success);
				}

				const validated = validateRoleBindings(cfg);
				if (Result.isFailure(validated)) {
					return yield* validated.failure;
				}
				return validated.success;
			});

		const resolveRoleCmd = (
			cfg: ApneaConfig,
			role: Role,
			mode: RoleMode = ROLE_MODE[role],
		): Effect.Effect<string[], ConfigError> =>
			Effect.gen(function* () {
				const binding = cfg.roles[role];
				if (!binding) {
					return yield* new ConfigError({
						message: `no role binding for ${role}`,
					});
				}
				const profile = cfg.profiles[binding.profile];
				if (!profile) {
					return yield* new ConfigError({
						message: `unknown profile ${binding.profile}`,
					});
				}
				const cmd =
					mode === "oneshot" ? profile.cmd_oneshot : profile.cmd_interactive;
				if (!cmd?.length) {
					return yield* new ConfigError({
						message: `profile ${binding.profile} has no cmd_${mode}`,
					});
				}
				return [...cmd];
			});

		return Config.of({ load, resolveRoleCmd });
	}),
);
