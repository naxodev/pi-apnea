/**
 * Join shell line-continuations before anything else looks at the lines.
 *
 * A trailing `\` means "this command continues"; splitting on newlines alone
 * turns one command into two broken ones. The failure is badly disguised: the
 * commit gate reported `grep: \: No such file or directory` and refused a
 * phase whose real checks had all passed, so the message pointed at `grep`
 * rather than at the parser.
 *
 * An EVEN number of trailing backslashes is an escaped backslash, not a
 * continuation, so only an odd run continues the line.
 */
function joinContinuations(body: string): string {
	// Whitespace on BOTH sides of the break is consumed and replaced by exactly
	// one space, so `a \` + `  b` joins as `a b` rather than `a  b`.
	return body.replace(/[ \t]*(\\*)\\[ \t]*\r?\n[ \t]*/g, (match, prefix: string) =>
		prefix.length % 2 === 0 ? " " : match,
	);
}

function commandsFromFenceBody(body: string): string[] {
	const cmds: string[] = [];
	for (const line of joinContinuations(body).split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		cmds.push(t);
	}
	return cmds;
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

	// Last resort: $ / test / bun lines
	const cmds: string[] = [];
	for (const line of phasePackageText.split(/\r?\n/)) {
		const m = line.match(
			/^\s*(?:\$\s+)?((?:test |node |npm |bun |bunx |chmod |head ).+)$/,
		);
		if (m) cmds.push(m[1]!.trim());
	}
	return cmds;
}
