import { Result, Schema } from "effect";
import { ConfigError } from "../errors.ts";
import {
	DEFAULT_TIMEOUTS,
	ROLE_MODE,
	type ApneaConfig,
	type PaneStyle,
	type Profile,
	type Role,
	type RoleMode,
} from "../domain/types.ts";

const StringArray = Schema.Array(Schema.String);

const ProfileSchema = Schema.Struct({
	cmd_oneshot: Schema.optional(StringArray),
	cmd_interactive: Schema.optional(StringArray),
});

const RoleBindingSchema = Schema.Struct({
	profile: Schema.String.check(Schema.isMinLength(1)),
});

const PaneStyleSchema = Schema.Literals(["regular", "floating"] as const);

/**
 * Mirrors `schemas/config.schema.json` top-level keys.
 *
 * `review_round_cap` / `timeouts_ms` carry no range `check`: an out-of-range
 * number must fall back to the default (see below), not fail the decode. A
 * hard failure here bricks every tool until the file is hand-edited.
 */
export const GlobalConfigSchema = Schema.Struct({
	profiles: Schema.optional(Schema.Record(Schema.String, ProfileSchema)),
	roles: Schema.optional(Schema.Record(Schema.String, RoleBindingSchema)),
	review_round_cap: Schema.optional(Schema.Number),
	timeouts_ms: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
	pane_style: Schema.optional(PaneStyleSchema),
});

const PROJECT_KNOWN = new Set([
	"roles",
	"review_round_cap",
	"timeouts_ms",
	"isolation",
	"pane_style",
]);

const PROJECT_FORBIDDEN = new Set([
	"cmd",
	"cmd_oneshot",
	"cmd_interactive",
	"bin",
	"profiles",
]);

/**
 * Project overlay — unknown keys and profile-owned keys fail decode.
 * Range-tolerant for the same reason as `GlobalConfigSchema`.
 */
export const ProjectConfigSchema = Schema.Struct({
	roles: Schema.optional(Schema.Record(Schema.String, RoleBindingSchema)),
	review_round_cap: Schema.optional(Schema.Number),
	timeouts_ms: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
	isolation: Schema.optional(Schema.Literal("shared_cwd")),
	pane_style: Schema.optional(PaneStyleSchema),
});

function configFail(
	message: string,
	path?: string,
): Result.Result<never, ConfigError> {
	return Result.fail(
		path !== undefined
			? new ConfigError({ message, path })
			: new ConfigError({ message }),
	);
}

function asObject(
	v: unknown,
	label: string,
): Result.Result<Record<string, unknown>, ConfigError> {
	if (!v || typeof v !== "object" || Array.isArray(v)) {
		return configFail(`${label} must be a JSON object`);
	}
	return Result.succeed(v as Record<string, unknown>);
}

/** Decode + apply parseGlobal defaults into ApneaConfig. */
export function decodeGlobalConfig(
	raw: unknown,
): Result.Result<ApneaConfig, ConfigError> {
	const objR = asObject(raw, "global config");
	if (Result.isFailure(objR)) return configFail(objR.failure.message);

	const obj = objR.success;

	if (
		"isolation" in obj &&
		obj.isolation !== undefined &&
		obj.isolation !== "shared_cwd"
	) {
		return configFail(
			`unimplemented config value isolation=${JSON.stringify(obj.isolation)} (v1 only supports shared_cwd or omit)`,
		);
	}

	// Reject cmd-like keys nested under roles before struct decode.
	if (obj.roles && typeof obj.roles === "object" && !Array.isArray(obj.roles)) {
		for (const [k, v] of Object.entries(obj.roles as Record<string, unknown>)) {
			if (!v || typeof v !== "object" || Array.isArray(v)) continue;
			const r = v as Record<string, unknown>;
			for (const bad of PROJECT_FORBIDDEN) {
				if (bad !== "profiles" && bad in r) {
					return configFail(`roles.${k} must not include ${bad}; use profiles`);
				}
			}
		}
	}

	const decoded = Schema.decodeUnknownResult(GlobalConfigSchema)(obj);
	if (Result.isFailure(decoded)) {
		return configFail(decoded.failure.message);
	}

	const d = decoded.success;
	const profiles: Record<string, Profile> = {};
	for (const [name, p] of Object.entries(d.profiles ?? {})) {
		const out: Profile = {};
		if (p.cmd_oneshot) out.cmd_oneshot = [...p.cmd_oneshot];
		if (p.cmd_interactive) out.cmd_interactive = [...p.cmd_interactive];
		if (!out.cmd_oneshot?.length && !out.cmd_interactive?.length) {
			return configFail(
				`profile ${name} needs cmd_oneshot and/or cmd_interactive`,
			);
		}
		profiles[name] = out;
	}

	const roles: Record<string, { profile: string }> = {};
	for (const [k, v] of Object.entries(d.roles ?? {})) {
		roles[k] = { profile: v.profile };
	}

	const timeouts = { ...DEFAULT_TIMEOUTS };
	if (d.timeouts_ms) {
		for (const [k, v] of Object.entries(d.timeouts_ms)) {
			if (typeof v === "number" && v >= 1000) timeouts[k] = v;
		}
	}

	const pane_style: PaneStyle =
		d.pane_style === "regular" || d.pane_style === "floating"
			? d.pane_style
			: "regular";

	return Result.succeed({
		profiles,
		roles,
		review_round_cap:
			typeof d.review_round_cap === "number" && d.review_round_cap >= 1
				? d.review_round_cap
				: 3,
		timeouts_ms: timeouts,
		pane_style,
	});
}

/** Validate project overlay (unknown keys fail). Does not merge. */
export function decodeProjectConfig(
	raw: unknown,
): Result.Result<typeof ProjectConfigSchema.Type, ConfigError> {
	if (raw == null) {
		return Result.succeed({});
	}
	const objR = asObject(raw, "project config");
	if (Result.isFailure(objR)) return configFail(objR.failure.message);

	const obj = objR.success;

	for (const key of Object.keys(obj)) {
		if (PROJECT_FORBIDDEN.has(key)) {
			return configFail(
				`project config must not set ${key} (binaries/profiles only allowed in global config)`,
			);
		}
		if (!PROJECT_KNOWN.has(key)) {
			return configFail(`unknown project config key: ${key}`);
		}
		if (
			key === "isolation" &&
			obj.isolation !== "shared_cwd" &&
			obj.isolation !== undefined
		) {
			return configFail(
				`unimplemented isolation=${JSON.stringify(obj.isolation)}`,
			);
		}
	}

	// roles must not carry profile-owned keys
	if (obj.roles && typeof obj.roles === "object" && !Array.isArray(obj.roles)) {
		for (const [k, v] of Object.entries(obj.roles as Record<string, unknown>)) {
			if (!v || typeof v !== "object" || Array.isArray(v)) {
				return configFail(`project roles.${k} must be a JSON object`);
			}
			const r = v as Record<string, unknown>;
			for (const bad of ["cmd", "cmd_oneshot", "cmd_interactive", "bin"]) {
				if (bad in r) {
					return configFail(`project roles.${k} must not set ${bad}`);
				}
			}
		}
	}

	const decoded = Schema.decodeUnknownResult(ProjectConfigSchema)(obj, {
		onExcessProperty: "error",
	});
	if (Result.isFailure(decoded)) {
		return configFail(decoded.failure.message);
	}
	return Result.succeed(decoded.success);
}

/**
 * Merge a validated project overlay onto a base config.
 * Profiles always stay from the base (global-only).
 */
export function applyProjectConfig(
	cfg: ApneaConfig,
	overlay: typeof ProjectConfigSchema.Type,
): ApneaConfig {
	const roles = { ...cfg.roles };
	if (overlay.roles) {
		for (const [k, v] of Object.entries(overlay.roles)) {
			roles[k] = { profile: v.profile };
		}
	}
	const timeouts = { ...cfg.timeouts_ms };
	if (overlay.timeouts_ms) {
		for (const [k, v] of Object.entries(overlay.timeouts_ms)) {
			if (typeof v === "number" && v >= 1000) timeouts[k] = v;
		}
	}
	return {
		profiles: cfg.profiles,
		roles,
		review_round_cap:
			overlay.review_round_cap !== undefined && overlay.review_round_cap >= 1
				? overlay.review_round_cap
				: cfg.review_round_cap,
		timeouts_ms: timeouts,
		pane_style:
			overlay.pane_style !== undefined ? overlay.pane_style : cfg.pane_style,
	};
}

/**
 * Resolve role → profile → `cmd_<mode>`. Shared by `ConfigLive` and the test
 * fake so tests exercise the real resolution instead of a copy of it.
 *
 * Deliberately distinct from `validateRoleBindings` below: this is the runtime
 * lookup, that one is the setup-time audit and phrases the same failures as
 * actionable config guidance.
 */
export function resolveRoleCmdResult(
	cfg: ApneaConfig,
	role: Role,
	mode: RoleMode = ROLE_MODE[role],
): Result.Result<string[], ConfigError> {
	const binding = cfg.roles[role];
	if (!binding) {
		return configFail(`no role binding for ${role}`);
	}
	const profile = cfg.profiles[binding.profile];
	if (!profile) {
		return configFail(`unknown profile ${binding.profile}`);
	}
	const cmd =
		mode === "oneshot" ? profile.cmd_oneshot : profile.cmd_interactive;
	if (!cmd?.length) {
		return configFail(`profile ${binding.profile} has no cmd_${mode}`);
	}
	return Result.succeed([...cmd]);
}

/**
 * Validate planner/reviewer/coder role→profile bindings and required cmds.
 * Success returns cfg unchanged.
 */
export function validateRoleBindings(
	cfg: ApneaConfig,
): Result.Result<ApneaConfig, ConfigError> {
	for (const role of ["planner", "reviewer", "coder"] as Role[]) {
		const binding = cfg.roles[role];
		if (!binding) {
			return configFail(`config missing roles.${role}`);
		}
		const profile = cfg.profiles[binding.profile];
		if (!profile) {
			return configFail(
				`roles.${role} profile "${binding.profile}" not defined in global profiles`,
			);
		}
		const mode = ROLE_MODE[role];
		const cmd =
			mode === "oneshot" ? profile.cmd_oneshot : profile.cmd_interactive;
		if (!cmd?.length) {
			return configFail(
				`profile "${binding.profile}" missing cmd_${mode} required by role ${role}`,
			);
		}
	}
	return Result.succeed(cfg);
}
