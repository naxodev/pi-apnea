import { describe, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { globalConfigPath, projectConfigPath } from "../domain/paths.ts";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { itEffect } from "../test/it-effect.ts";
import { Config, ConfigLive } from "./config.ts";

function withFake(initial: Record<string, string> = {}) {
	const fake = makeFakeFileSystem(initial);
	const layer = Layer.provideMerge(ConfigLive, fake.layer);
	return { fake, layer };
}

const validGlobal = JSON.stringify({
	profiles: {
		pi: { cmd_interactive: ["pi"] },
	},
	roles: {
		planner: { profile: "pi" },
		reviewer: { profile: "pi" },
		coder: { profile: "pi" },
	},
});

describe("Config service (fake FileSystem)", () => {
	itEffect("missing global config → ConfigError with path", () => {
		const { layer } = withFake();
		return Effect.gen(function* () {
			const config = yield* Config;
			const r = yield* Effect.result(config.load("/proj"));
			expect(r._tag).toBe("Failure");
			if (r._tag === "Failure") {
				expect(r.failure._tag).toBe("ConfigError");
				expect(r.failure.message).toContain("missing global config");
				expect(r.failure.path).toBe(globalConfigPath());
			}
		}).pipe(Effect.provide(layer));
	});

	itEffect("invalid JSON → ConfigError", () => {
		const g = globalConfigPath();
		const { layer } = withFake({ [g]: "{bad" });
		return Effect.gen(function* () {
			const config = yield* Config;
			const r = yield* Effect.result(config.load("/proj"));
			expect(r._tag).toBe("Failure");
			if (r._tag === "Failure") {
				expect(r.failure.message).toContain("invalid JSON");
				expect(r.failure.path).toBe(g);
			}
		}).pipe(Effect.provide(layer));
	});

	itEffect("happy path returns merged cfg", () => {
		const g = globalConfigPath();
		const p = projectConfigPath("/proj");
		const { layer } = withFake({
			[g]: validGlobal,
			[p]: JSON.stringify({
				review_round_cap: 7,
				roles: { coder: { profile: "pi" } },
			}),
		});
		return Effect.gen(function* () {
			const config = yield* Config;
			const cfg = yield* config.load("/proj");
			expect(cfg.review_round_cap).toBe(7);
			expect(cfg.roles.coder).toEqual({ profile: "pi" });
			expect(cfg.profiles.pi?.cmd_interactive).toEqual(["pi"]);
		}).pipe(Effect.provide(layer));
	});

	itEffect("forbidden project key → ConfigError", () => {
		const g = globalConfigPath();
		const p = projectConfigPath("/proj");
		const { layer } = withFake({
			[g]: validGlobal,
			[p]: JSON.stringify({ profiles: { x: { cmd_interactive: ["x"] } } }),
		});
		return Effect.gen(function* () {
			const config = yield* Config;
			const r = yield* Effect.result(config.load("/proj"));
			expect(r._tag).toBe("Failure");
			if (r._tag === "Failure") {
				expect(r.failure.message).toContain("must not set profiles");
			}
		}).pipe(Effect.provide(layer));
	});

	itEffect("resolveRoleCmd unknown profile → ConfigError", () => {
		const g = globalConfigPath();
		const { layer } = withFake({ [g]: validGlobal });
		return Effect.gen(function* () {
			const config = yield* Config;
			const cfg = yield* config.load("/proj");
			const bad = {
				...cfg,
				roles: { ...cfg.roles, planner: { profile: "nope" } },
			};
			const r = yield* Effect.result(config.resolveRoleCmd(bad, "planner"));
			expect(r._tag).toBe("Failure");
			if (r._tag === "Failure") {
				expect(r.failure.message).toContain("unknown profile nope");
			}
		}).pipe(Effect.provide(layer));
	});

	itEffect("resolveRoleCmd returns a copy of the cmd array", () => {
		const g = globalConfigPath();
		const { layer } = withFake({ [g]: validGlobal });
		return Effect.gen(function* () {
			const config = yield* Config;
			const cfg = yield* config.load("/proj");
			const cmd = yield* config.resolveRoleCmd(cfg, "planner");
			expect(cmd).toEqual(["pi"]);
			cmd.push("extra");
			expect(cfg.profiles.pi?.cmd_interactive).toEqual(["pi"]);
		}).pipe(Effect.provide(layer));
	});
});
