import * as fs from "node:fs";
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

export function globalConfigPath(): string {
	return path.join(os.homedir(), ".config", "apnea", "config.json");
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
	// extension/lib -> package root
	return path.resolve(here, "..", "..");
}

export function briefPath(role: string): string {
	return path.join(packageRoot(), "briefs", `${role}.md`);
}

export function ensureApneaDirs(root = cwd()): void {
	for (const d of [
		apneaRoot(root),
		artifactsDir(root),
		tasksDir(root),
		path.join(artifactsDir(root), "plan-review"),
	]) {
		fs.mkdirSync(d, { recursive: true });
	}
}

export function ensureDirForFile(filePath: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
