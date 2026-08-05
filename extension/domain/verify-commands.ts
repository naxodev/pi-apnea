/**
 * Drop whole-line `#` comments.
 *
 * Runs BEFORE continuations are joined, because a shell comment extends to the
 * end of its physical line: the `\` in `# note \` is inside the comment and
 * continues nothing. Joining first and filtering after merged the comment with
 * the command below it and then discarded both, so a fence whose first line was
 * a trailing-backslash comment lost its next command entirely — `bun test
 * extension` silently never ran and the phase committed green.
 */
function stripComments(lines: string[]): string[] {
	return lines.filter((line) => !line.trim().startsWith("#"));
}

/**
 * Join shell line-continuations, line by line.
 *
 * A line ends in a continuation when it ends in an ODD run of backslashes; an
 * even run is escaped literals and ends the command. The final backslash is
 * removed and the next line is appended with NOTHING between them — that is
 * what a shell does, and it is the part the first version of this got wrong.
 * It substituted a single space, which corrupts two real cases:
 *
 *   test -f docs/over\ + view.md   -> `over view.md`, not `overview.md`
 *   grep -q 'foo \    + `   bar'`  -> the quoted pattern silently changes
 *
 * The second is the dangerous one: the gate greps a pattern nobody wrote and
 * can report a pass for a check that never held.
 *
 * The backslash must also be the LAST character. `echo hi \ ` with a trailing
 * space escapes the space and ends the command; treating it as a continuation
 * swallowed the following command as an argument, so the suite went unrun and
 * the gate passed.
 */
function joinContinuations(lines: string[]): string[] {
	const out: string[] = [];
	let acc = "";
	let pending = false;
	for (const line of lines) {
		const run = /(\\+)$/.exec(line);
		const continues = run !== null && run[1]!.length % 2 === 1;
		// Drop only the final backslash; an odd run longer than one leaves
		// literal backslashes behind that the command still needs.
		const text = continues ? line.slice(0, -1) : line;
		acc = pending ? acc + text : text;
		pending = continues;
		if (!continues) {
			out.push(acc);
			acc = "";
		}
	}
	// A dangling continuation on the last line: keep what we have rather than
	// dropping the command on the floor.
	if (pending) out.push(acc);
	return out;
}

function toCommands(lines: string[]): string[] {
	const cmds: string[] = [];
	for (const joined of joinContinuations(stripComments(lines))) {
		const t = joined.trim();
		if (t) cmds.push(t);
	}
	return cmds;
}

function commandsFromFenceBody(body: string): string[] {
	return toCommands(body.split(/\r?\n/));
}

/**
 * Extract shell commands from a phase package.
 * Prefer the fence under a "Verify commands" heading — packages often embed
 * earlier ```bash sketches that must not be executed at the commit gate.
 */
export function extractVerifyCommands(phasePackageText: string): string[] {
	// Heading-scoped fence first (## / ### / **Verify commands**)
	const section = phasePackageText.match(
		/(?:^|\n)(?:#{1,6}\s*|\*\*)Verify commands(?:\*\*)?\s*\r?\n([\s\S]*?)(?=\n#{1,6}\s|\n\*\*[A-Z]|$)/i,
	);
	if (section) {
		const fence = section[1]!.match(/```(?:sh|bash|shell)\r?\n([\s\S]*?)```/i);
		if (fence) {
			const cmds = commandsFromFenceBody(fence[1]!);
			if (cmds.length) return cmds;
		}
	}

	// Fallback: last sh/bash fence in the doc (verify blocks are usually last)
	const all = [
		...phasePackageText.matchAll(/```(?:sh|bash|shell)\r?\n([\s\S]*?)```/gi),
	];
	for (let i = all.length - 1; i >= 0; i--) {
		const cmds = commandsFromFenceBody(all[i]![1]!);
		if (cmds.length) return cmds;
	}

	// Last resort: $ / test / bun lines.
	//
	// Joined first, like both fence paths. This path was left splitting on raw
	// newlines when continuations were introduced, so a package with no fence
	// still dropped the continuation line and kept a dangling backslash — the
	// original bug, still live in the one path nobody looked at.
	const cmds: string[] = [];
	for (const line of joinContinuations(
		stripComments(phasePackageText.split(/\r?\n/)),
	)) {
		const m = line.match(
			/^\s*(?:\$\s+)?((?:test |node |npm |bun |bunx |chmod |head ).+)$/,
		);
		if (m) cmds.push(m[1]!.trim());
	}
	return cmds;
}
