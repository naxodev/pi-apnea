import { Result, Schema } from "effect";
import { ConfigError } from "../errors.ts";
import {
	DEFAULT_TIMEOUTS,
	type ApneaConfig,
	type PaneStyle,
	type Profile,
} from "../lib/types.ts";

const StringArray = Schema.Array(Schema.String);

const ProfileSchema = Schema.Struct({
	cmd_oneshot: Schema.optional(StringArray),
	cmd_interactive: Schema.optional(StringArray),
});

const RoleBindingSchema = Schema.Struct({
	profile: Schema.String.check(Schema.isMinLength(1)),
});

const PaneStyleSchema = Schema.Literals(["regular", "floating"] as const);

/** Mirrors `schemas/config.schema.json` top-level keys. */
export const GlobalConfigSchema = Schema.Struct({
	profiles: Schema.optional(Schema.Record(Schema.String, ProfileSchema)),
	roles: Schema.optional(Schema.Record(Schema.String, RoleBindingSchema)),
	review_round_cap: Schema.optional(
		Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
	),
	timeouts_ms: Schema.optional(
		Schema.Record(
			Schema.String,
			Schema.Number.check(Schema.isGreaterThanOrEqualTo(1000)),
		),
	),
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

/** Project overlay — unknown keys and profile-owned keys fail decode. */
export const ProjectConfigSchema = Schema.Struct({
	roles: Schema.optional(Schema.Record(Schema.String, RoleBindingSchema)),
	review_round_cap: Schema.optional(
		Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
	),
	timeouts_ms: Schema.optional(
		Schema.Record(
			Schema.String,
			Schema.Number.check(Schema.isGreaterThanOrEqualTo(1000)),
		),
	),
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
