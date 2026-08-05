/** Does this line end in an ODD run of backslashes — a shell continuation? */
function endsInContinuation(line: string): boolean {
	const run = /(\\+)$/.exec(line);
	return run !== null && run[1]!.length % 2 === 1;
}

/**
 * Split fence lines into logical shell commands: continuations joined,
 * comments dropped — in ONE pass, because the two interact and both split
 * orderings shipped bugs.
 *
 * Join-then-strip (version 1): a comment ending in `\` swallowed the command
 * below it, then the merged line was dropped as a comment — `bun test
 * extension` silently never ran and the phase committed green.
 *
 * Strip-then-join (version 2): removing a comment line that sat BETWEEN a
 * continued line and the next command spliced the two commands together —
 * `test -f README.md \` + `# note` + `bun test extension` became one command.
 *
 * bash resolves this by interleaving, and each command later runs through
 * `bash -lc`, so bash's rules are the spec:
 *
 * - Joining appends the next line with NOTHING between; the final backslash of
 *   an odd run is dropped, the rest stay (they are escaped literals). A
 *   backslash that is not the line's last character continues nothing —
 *   `echo hi \ ` escapes the space and ends the command.
 * - A `#` at the start of a logical command is a comment; its own trailing
 *   backslash is inside the comment and continues nothing.
 * - A comment line reached MID-continuation ends the logical command, when the
 *   `#` would start a word in the joined text (whitespace before it). Without
 *   whitespace on either side of the join, `over\` + `#note` is the single
 *   word `over#note`, not a comment — so it is appended, not terminated on.
 */
function logicalCommands(lines: string[]): string[] {
	const out: string[] = [];
	let acc = "";
	let pending = false;
	for (const line of lines) {
		const isCommentish = line.trim().startsWith("#");
		if (!pending && isCommentish) continue;
		if (pending && isCommentish && (/\s$/.test(acc) || /^\s/.test(line))) {
			out.push(acc);
			acc = "";
			pending = false;
			continue;
		}
		const continues = endsInContinuation(line);
		const text = continues ? line.slice(0, -1) : line;
		acc = pending ? acc + text : text;
		pending = continues;
		if (!pending) {
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
	for (const joined of logicalCommands(lines)) {
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

	// Last resort: $ / test / bun lines scattered through prose.
	//
	// Continuations join FORWARD FROM A MATCHED COMMAND LINE only, never
	// document-wide. This text is markdown, not shell, and a trailing backslash
	// on a prose line is a markdown hard break: joining globally glued prose
	// onto the command below it, the merged line no longer matched the command
	// pattern, and the check was silently dropped — the gate ran a subset of
	// the verify commands and committed the phase green. Comments need no
	// handling here: a line starting with `#` cannot match the pattern.
	const cmds: string[] = [];
	const rawLines = phasePackageText.split(/\r?\n/);
	for (let i = 0; i < rawLines.length; i++) {
		const m = rawLines[i]!.match(
			/^\s*(?:\$\s+)?((?:test |node |npm |bun |bunx |chmod |head ).+)$/,
		);
		if (!m) continue;
		let cmd = m[1]!;
		while (endsInContinuation(cmd) && i + 1 < rawLines.length) {
			cmd = cmd.slice(0, -1) + rawLines[++i]!;
		}
		// Dangling continuation on the final line: drop the backslash rather
		// than handing the shell a command that continues into nothing.
		if (endsInContinuation(cmd)) cmd = cmd.slice(0, -1);
		cmds.push(cmd.trim());
	}
	return cmds;
}
