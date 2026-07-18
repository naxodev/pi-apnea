import * as fs from "node:fs";
import { globalConfigPath, packageRoot, projectConfigPath } from "./paths.ts";
import {
	DEFAULT_TIMEOUTS,
	type ApneaConfig,
	type Profile,
	type Role,
	type RoleMode,
	ROLE_MODE,
} from "./types.ts";

const FORBIDDEN_PROJECT_KEYS = new Set([
	"cmd",
	"cmd_oneshot",
	"cmd_interactive",
	"bin",
	"profiles",
]);

function readJson(filePath: string): unknown {
	if (!fs.existsSync(filePath)) return null;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (e) {
		throw new Error(
			`invalid JSON at ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

function assertObject(v: unknown, label: string): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) {
		throw new Error(`${label} must be a JSON object`);
	}
	return v as Record<string, unknown>;
}

function parseProfile(name: string, raw: unknown): Profile {
	const o = assertObject(raw, `profile ${name}`);
	const out: Profile = {};
	if (o.cmd_oneshot !== undefined) {
		if (
			!Array.isArray(o.cmd_oneshot) ||
			!o.cmd_oneshot.every((x) => typeof x === "string")
		) {
			throw new Error(`profile ${name}.cmd_oneshot must be string[]`);
		}
		out.cmd_oneshot = o.cmd_oneshot as string[];
	}
	if (o.cmd_interactive !== undefined) {
		if (
			!Array.isArray(o.cmd_interactive) ||
			!o.cmd_interactive.every((x) => typeof x === "string")
		) {
			throw new Error(`profile ${name}.cmd_interactive must be string[]`);
		}
		out.cmd_interactive = o.cmd_interactive as string[];
	}
	if (!out.cmd_oneshot && !out.cmd_interactive) {
		throw new Error(`profile ${name} needs cmd_oneshot and/or cmd_interactive`);
	}
	return out;
}

function parseGlobal(raw: unknown): ApneaConfig {
	const o = assertObject(raw, "global config");
	if (
		"isolation" in o &&
		o.isolation !== undefined &&
		o.isolation !== "shared_cwd"
	) {
		throw new Error(
			`unimplemented config value isolation=${JSON.stringify(o.isolation)} (v1 only supports shared_cwd or omit)`,
		);
	}
	const profilesIn = assertObject(o.profiles ?? {}, "profiles");
	const profiles: Record<string, Profile> = {};
	for (const [k, v] of Object.entries(profilesIn)) {
		profiles[k] = parseProfile(k, v);
	}
	const rolesIn = assertObject(o.roles ?? {}, "roles");
	const roles: Record<string, { profile: string }> = {};
	for (const [k, v] of Object.entries(rolesIn)) {
		const r = assertObject(v, `roles.${k}`);
		if (typeof r.profile !== "string" || !r.profile) {
			throw new Error(`roles.${k}.profile required`);
		}
		// reject cmd in role even globally if nested wrong
		for (const bad of FORBIDDEN_PROJECT_KEYS) {
			if (bad !== "profiles" && bad in r) {
				throw new Error(`roles.${k} must not include ${bad}; use profiles`);
			}
		}
		roles[k] = { profile: r.profile };
	}
	const timeouts = { ...DEFAULT_TIMEOUTS };
	if (o.timeouts_ms && typeof o.timeouts_ms === "object") {
		for (const [k, v] of Object.entries(
			o.timeouts_ms as Record<string, unknown>,
		)) {
			if (typeof v === "number" && v >= 1000) timeouts[k] = v;
		}
	}
	return {
		profiles,
		roles,
		review_round_cap:
			typeof o.review_round_cap === "number" && o.review_round_cap >= 1
				? o.review_round_cap
				: 3,
		timeouts_ms: timeouts,
	};
}

function applyProject(cfg: ApneaConfig, raw: unknown): ApneaConfig {
	if (raw == null) return cfg;
	const o = assertObject(raw, "project config");
	for (const key of Object.keys(o)) {
		if (FORBIDDEN_PROJECT_KEYS.has(key)) {
			throw new Error(
				`project config must not set ${key} (binaries/profiles only allowed in ${globalConfigPath()})`,
			);
		}
		if (
			key === "isolation" &&
			o.isolation !== "shared_cwd" &&
			o.isolation !== undefined
		) {
			throw new Error(`unimplemented isolation=${JSON.stringify(o.isolation)}`);
		}
	}
	const known = new Set([
		"roles",
		"review_round_cap",
		"timeouts_ms",
		"isolation",
	]);
	for (const key of Object.keys(o)) {
		if (!known.has(key)) {
			throw new Error(`unknown project config key: ${key}`);
		}
	}
	const roles = { ...cfg.roles };
	if (o.roles) {
		const rolesIn = assertObject(o.roles, "project roles");
		for (const [k, v] of Object.entries(rolesIn)) {
			const r = assertObject(v, `project roles.${k}`);
			if (typeof r.profile !== "string") {
				throw new Error(`project roles.${k}.profile required`);
			}
			for (const bad of ["cmd", "cmd_oneshot", "cmd_interactive", "bin"]) {
				if (bad in r) {
					throw new Error(`project roles.${k} must not set ${bad}`);
				}
			}
			roles[k] = { profile: r.profile };
		}
	}
	const timeouts = { ...cfg.timeouts_ms };
	if (o.timeouts_ms && typeof o.timeouts_ms === "object") {
		for (const [k, v] of Object.entries(
			o.timeouts_ms as Record<string, unknown>,
		)) {
			if (typeof v === "number" && v >= 1000) timeouts[k] = v;
		}
	}
	return {
		profiles: cfg.profiles,
		roles,
		review_round_cap:
			typeof o.review_round_cap === "number" && o.review_round_cap >= 1
				? o.review_round_cap
				: cfg.review_round_cap,
		timeouts_ms: timeouts,
	};
}

export function loadConfig(projectRoot: string): ApneaConfig {
	const gPath = globalConfigPath();
	const gRaw = readJson(gPath);
	if (!gRaw) {
		throw new Error(
			`missing global config at ${gPath}. Run apnea-setup / create profiles there.`,
		);
	}
	let cfg = parseGlobal(gRaw);
	const pRaw = readJson(projectConfigPath(projectRoot));
	cfg = applyProject(cfg, pRaw);

	// validate role→profile bindings for known roles
	for (const role of ["planner", "reviewer", "coder"] as Role[]) {
		const binding = cfg.roles[role];
		if (!binding) {
			throw new Error(`config missing roles.${role}`);
		}
		const profile = cfg.profiles[binding.profile];
		if (!profile) {
			throw new Error(
				`roles.${role} profile "${binding.profile}" not defined in global profiles`,
			);
		}
		const mode = ROLE_MODE[role];
		const cmd =
			mode === "oneshot" ? profile.cmd_oneshot : profile.cmd_interactive;
		if (!cmd?.length) {
			throw new Error(
				`profile "${binding.profile}" missing cmd_${mode} required by role ${role}`,
			);
		}
	}
	return cfg;
}

export function resolveRoleCmd(
	cfg: ApneaConfig,
	role: Role,
	mode: RoleMode = ROLE_MODE[role],
): string[] {
	const binding = cfg.roles[role];
	if (!binding) throw new Error(`no role binding for ${role}`);
	const profile = cfg.profiles[binding.profile];
	if (!profile) throw new Error(`unknown profile ${binding.profile}`);
	const cmd =
		mode === "oneshot" ? profile.cmd_oneshot : profile.cmd_interactive;
	if (!cmd?.length) {
		throw new Error(`profile ${binding.profile} has no cmd_${mode}`);
	}
	return [...cmd];
}

export function getPackageRoot(): string {
	return packageRoot();
}
