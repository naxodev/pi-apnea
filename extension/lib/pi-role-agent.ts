/**
 * Role-pane pi launches must not load pi-vimmode. Modal vim intercepts
 * herdr `pane run` pastes and leaves the pointer sitting in INSERT — the
 * single biggest cause of idle-without-artifact stalls for the coder.
 *
 * Strategy: materialize a dedicated PI_CODING_AGENT_DIR that reuses the
 * user's auth/npm/skills but filters pi-vimmode out of packages, then wrap
 * interactive `pi` launches with that env. Reused panes also get a
 * best-effort `/vimmode off` slash command.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { globalConfigPath } from "./paths.ts";

const PI_VIMMODE_MARKERS = ["pi-vimmode", "pekochan069/pi-vimmode"];

export function isPiCmd(cmd: string[] | undefined | null): boolean {
	if (!cmd?.length) return false;
	const bin = path.basename(cmd[0]!);
	return bin === "pi";
}

export function packageSource(entry: unknown): string | null {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && !Array.isArray(entry)) {
		const src = (entry as Record<string, unknown>).source;
		return typeof src === "string" ? src : null;
	}
	return null;
}

/** True when a packages[] entry is (or wraps) pi-vimmode. */
export function isPiVimModePackage(entry: unknown): boolean {
	const src = packageSource(entry);
	if (!src) return false;
	const lower = src.toLowerCase();
	return PI_VIMMODE_MARKERS.some((m) => lower.includes(m));
}

/**
 * Drop pi-vimmode from a packages list. Leaves every other entry intact
 * (string form and object form with filters).
 */
export function filterPackagesNoVim(packages: unknown): unknown[] {
	if (!Array.isArray(packages)) return [];
	return packages.filter((p) => !isPiVimModePackage(p));
}

export function defaultSourceAgentDir(): string {
	return (
		process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
	);
}

export function defaultRoleAgentDir(): string {
	return path.join(path.dirname(globalConfigPath()), "pi-role-agent");
}

function symlinkOrCopy(src: string, dest: string): void {
	if (!fs.existsSync(src)) return;
	try {
		if (fs.existsSync(dest) || fs.lstatSync(dest).isSymbolicLink()) {
			fs.rmSync(dest, { recursive: true, force: true });
		}
	} catch {
		try {
			fs.rmSync(dest, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
	try {
		fs.symlinkSync(src, dest);
	} catch {
		// Windows or no-symlink FS: copy
		const st = fs.statSync(src);
		if (st.isDirectory()) {
			fs.cpSync(src, dest, { recursive: true, force: true });
		} else {
			fs.copyFileSync(src, dest);
		}
	}
}

/**
 * Build (or refresh) a PI_CODING_AGENT_DIR for Apnea role panes.
 * - settings.json: user's packages minus pi-vimmode; piVimMode key stripped
 * - auth/npm/skills/extensions/themes/models: linked from the real agent dir
 *
 * Idempotent. Safe to call on every dispatch.
 */
export function materializePiRoleAgentDir(opts?: {
	sourceAgentDir?: string;
	destDir?: string;
}): string {
	const source = opts?.sourceAgentDir ?? defaultSourceAgentDir();
	const dest = opts?.destDir ?? defaultRoleAgentDir();
	fs.mkdirSync(dest, { recursive: true });

	const srcSettingsPath = path.join(source, "settings.json");
	let settings: Record<string, unknown> = {};
	if (fs.existsSync(srcSettingsPath)) {
		try {
			const raw = JSON.parse(fs.readFileSync(srcSettingsPath, "utf8"));
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				settings = { ...(raw as Record<string, unknown>) };
			}
		} catch {
			settings = {};
		}
	}

	settings.packages = filterPackagesNoVim(settings.packages);
	delete settings.piVimMode;

	fs.writeFileSync(
		path.join(dest, "settings.json"),
		`${JSON.stringify(settings, null, 2)}\n`,
		"utf8",
	);

	// Reuse identity + installed packages; keep sessions local to role dir.
	for (const name of [
		"auth.json",
		"npm",
		"skills",
		"extensions",
		"themes",
		"models.json",
		"bin",
		"tools",
	]) {
		symlinkOrCopy(path.join(source, name), path.join(dest, name));
	}

	// Optional: pi-vimmode.config.js must not apply either
	const vimCfg = path.join(dest, "pi-vimmode.config.js");
	if (fs.existsSync(vimCfg) || safeIsSymlink(vimCfg)) {
		try {
			fs.rmSync(vimCfg, { force: true });
		} catch {
			/* ignore */
		}
	}

	return dest;
}

function safeIsSymlink(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Prefix a pi interactive command with env PI_CODING_AGENT_DIR=... so the
 * role pane never loads pi-vimmode. Non-pi cmds pass through unchanged.
 * `opts` is for tests; production callers omit it.
 */
export function wrapInteractiveCmdNoVim(
	cmd: string[],
	opts?: { sourceAgentDir?: string; destDir?: string },
): string[] {
	if (!isPiCmd(cmd)) return cmd;
	const agentDir = materializePiRoleAgentDir(opts);
	return ["env", `PI_CODING_AGENT_DIR=${agentDir}`, ...cmd];
}
