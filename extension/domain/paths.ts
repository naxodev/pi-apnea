import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const APNEA_DIR = ".apnea";

export function cwd(): string {
	return process.cwd();
}

export function apneaRoot(root = cwd()): string {
	return path.join(root, APNEA_DIR);
}

export function statePath(root = cwd()): string {
	return path.join(apneaRoot(root), "state.json");
}

export function projectConfigPath(root = cwd()): string {
	return path.join(apneaRoot(root), "config.json");
}

function homedir(): string {
	// Env first so an overridden HOME still wins (Bun's os.homedir() reads the
	// passwd entry and ignores $HOME), then the passwd entry as the floor.
	// Never "": an empty home makes globalConfigPath() cwd-relative, i.e. the
	// *project* repo would be read as the trusted global config — the one place
	// profiles/cmd_interactive are honoured. node:os is a pure read here.
	return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function globalConfigPath(): string {
	return path.join(homedir(), ".config", "apnea", "config.json");
}

export function artifactsDir(root = cwd()): string {
	return path.join(apneaRoot(root), "artifacts");
}

export function tasksDir(root = cwd()): string {
	return path.join(apneaRoot(root), "tasks");
}

export function phaseDir(
	phaseIndex: number,
	round: number,
	root = cwd(),
): string {
	const n = String(phaseIndex).padStart(2, "0");
	return path.join(artifactsDir(root), `phase-${n}`, `round-${round}`);
}

export function planPath(root = cwd()): string {
	return path.join(artifactsDir(root), "plan.md");
}

export function planReviewPath(round: number, root = cwd()): string {
	return path.join(artifactsDir(root), "plan-review", `round-${round}.md`);
}

export function prDescriptionPath(root = cwd()): string {
	return path.join(artifactsDir(root), "pr-description.md");
}

export function rel(p: string, root = cwd()): string {
	return path.relative(root, p) || p;
}

export function abs(p: string, root = cwd()): string {
	return path.isAbsolute(p) ? p : path.join(root, p);
}

/** Package root (repo containing briefs/), resolved from this file. */
export function packageRoot(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	// extension/domain -> package root (same depth as extension/lib)
	return path.resolve(here, "..", "..");
}
