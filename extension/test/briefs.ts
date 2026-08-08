import { ROLE_MODE } from "../domain/types.ts";

/**
 * A brief file for every role, under the given package root.
 *
 * Dispatch refuses to launch a pane when the role's brief is missing — a role
 * told to read a file that is not there just stalls, silently — so a fixture
 * without briefs models a broken install, not a normal one.
 *
 * Derived from `ROLE_MODE`, not a hardcoded list: this fixture was previously
 * copy-pasted into two test files with the roles spelled out, so adding a role
 * meant remembering both copies, and a missed one failed as an opaque
 * `GateRefused("brief")` in tests about something else entirely.
 */
export function briefFiles(packageRoot: string): Record<string, string> {
	return Object.fromEntries(
		Object.keys(ROLE_MODE).map((role) => [
			`${packageRoot}/briefs/${role}.md`,
			`# ${role} brief\n`,
		]),
	);
}
