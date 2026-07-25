import { Effect, Layer } from "effect";
import { ConfigError } from "../errors.ts";
import {
	ROLE_MODE,
	type ApneaConfig,
	type Role,
	type RoleMode,
} from "../lib/types.ts";
import { Config, type ConfigService } from "../services/config.ts";

export type FakeConfigOptions = {
	/** Config returned by load (default: minimal valid). */
	cfg?: ApneaConfig;
	/** If set, load always fails with this error. */
	failLoad?: ConfigError;
};

const DEFAULT_CFG: ApneaConfig = {
	profiles: {
		pi: { cmd_interactive: ["pi"] },
	},
	roles: {
		planner: { profile: "pi" },
		reviewer: { profile: "pi" },
		coder: { profile: "pi" },
	},
	review_round_cap: 3,
	timeouts_ms: { verify: 900_000 },
	pane_style: "regular",
};

/** Config layer whose load succeeds with cfg (or fails with failLoad). */
export function fakeConfigLayer(
	opts: FakeConfigOptions | ApneaConfig = {},
): Layer.Layer<Config> {
	const options: FakeConfigOptions =
		"profiles" in opts ? { cfg: opts as ApneaConfig } : (opts as FakeConfigOptions);
	const cfg = options.cfg ?? DEFAULT_CFG;

	const service: ConfigService = {
		load: (_root) =>
			options.failLoad
				? Effect.fail(options.failLoad)
				: Effect.succeed(cfg),
		resolveRoleCmd: (c, role, mode = ROLE_MODE[role as Role]) =>
			Effect.gen(function* () {
				const binding = c.roles[role];
				if (!binding) {
					return yield* new ConfigError({
						message: `no role binding for ${role}`,
					});
				}
				const profile = c.profiles[binding.profile];
				if (!profile) {
					return yield* new ConfigError({
						message: `unknown profile ${binding.profile}`,
					});
				}
				const m: RoleMode = mode;
				const cmd =
					m === "oneshot" ? profile.cmd_oneshot : profile.cmd_interactive;
				if (!cmd?.length) {
					return yield* new ConfigError({
						message: `profile ${binding.profile} has no cmd_${m}`,
					});
				}
				return [...cmd];
			}),
	};

	return Layer.succeed(Config, Config.of(service));
}
