import { Effect, Layer, Result } from "effect";
import type { ConfigError } from "../errors.ts";
import { ROLE_MODE, type ApneaConfig, type Role } from "../domain/types.ts";
import { resolveRoleCmdResult } from "../schema/config.ts";
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
		// Only `load` is faked. Role→cmd resolution delegates to the same pure
		// function ConfigLive uses: a hand-copied resolver here would make every
		// dispatch test assert against the copy, so a real resolution bug could
		// not fail any test.
		resolveRoleCmd: (c, role, mode = ROLE_MODE[role as Role]) =>
			Effect.gen(function* () {
				const resolved = resolveRoleCmdResult(c, role, mode);
				if (Result.isFailure(resolved)) {
					return yield* resolved.failure;
				}
				return resolved.success;
			}),
	};

	return Layer.succeed(Config, Config.of(service));
}
