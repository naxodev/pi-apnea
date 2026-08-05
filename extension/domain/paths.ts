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

export const PACKAGE_NAME = "@naxodev/apnea";

/**
 * The package-root search, with the starting directory as a parameter.
 *
 * Returns `null` when it cannot find us. An earlier version guessed two levels
 * up instead — the exact wrong answer for the bundled and installed layouts
 * this function exists to handle, handed back as if it were a real result.
 * Callers can now tell "not found" from "found", and `dispatch` turns it into
 * a refusal naming the paths it tried.
 *
 * Split out from `packageRoot()` so a test can supply the layout rather than
 * inheriting whichever one the test runner happens to use. Testing
 * `packageRoot()` directly only ever exercises the source tree, where the old
 * two-levels-up rule was also correct — a test written that way passes against
 * the bug.
 */
export function findPackageRootFrom(startDir: string): string | null {
	let dir = startDir;
	for (let up = 0; up < 10; up++) {
		try {
			const manifest = fs.readFileSync(path.join(dir, "package.json"), "utf8");
			if ((JSON.parse(manifest) as { name?: string }).name === PACKAGE_NAME) {
				return dir;
			}
		} catch {
			// No package.json here, or it is not readable JSON. Keep walking.
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Package root — the directory holding `briefs/`, `herdr-plugin/`, and our
 * own `package.json`.
 *
 * Found by walking up and reading each `package.json`, NOT by counting
 * directory levels. The level count differs for every way this code runs, and
 * a wrong root is silent: `dispatch` still launches a pane, and the role sits
 * there having been told to read a brief that does not exist.
 *
 *   from source   extension/domain/paths.ts  -> 2 up
 *   from bundle   dist/cli.js                -> 1 up
 *   from npm      node_modules/@naxodev/apnea/dist/cli.js -> 1 up
 *
 * The old two-up rule was right only for source. `bun build` emits one file at
 * `dist/cli.js`, so the CLI resolved the repo's PARENT and every brief path it
 * printed was wrong — found by running the CLI against this repo, not by any
 * test, because the tests fake this function and the Pi extension happens to
 * load from source.
 *
 * Matching on the package NAME rather than on the presence of `package.json`
 * matters once this is installed as a dependency: the first `package.json`
 * above `node_modules/...` belongs to the consumer, not to us.
 *
 * The source-layout guess remains only as a last resort for a fork or rename,
 * where the name will never match. `dispatch` checks the brief exists before
 * launching, so a wrong guess surfaces as a refusal rather than a stalled role.
 */
export function packageRoot(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return findPackageRootFrom(here) ?? path.resolve(here, "..", "..");
}
