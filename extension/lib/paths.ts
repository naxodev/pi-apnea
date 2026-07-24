import * as fs from "node:fs";
import * as path from "node:path";

export {
	APNEA_DIR,
	abs,
	apneaRoot,
	artifactsDir,
	briefPath,
	cwd,
	globalConfigPath,
	packageRoot,
	phaseDir,
	planPath,
	planReviewPath,
	prDescriptionPath,
	projectConfigPath,
	rel,
	statePath,
	tasksDir,
} from "../domain/paths.ts";

import {
	apneaRoot,
	artifactsDir,
	cwd,
	tasksDir,
} from "../domain/paths.ts";

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
