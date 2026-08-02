export type HumanGateDeps = {
	isTty: () => boolean;
	prompt: (question: string) => Promise<string>;
};

export const prodHumanGateDeps: HumanGateDeps = {
	isTty: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
	prompt: async (question) => {
		process.stdout.write(question);
		for await (const line of console) return line.trim();
		return "";
	},
};

/**
 * Human-only confirmation for cap reset. An agent shelling out has captured
 * pipes, so the TTY check fails closed. `--i-am-human` remains available for
 * scripts and remote shells: the property this buys is auditability — the
 * bypass is named in the transcript — not prevention.
 */
export async function confirmHuman(
	gate: string,
	deps: HumanGateDeps,
	override: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (override) return { ok: true };
	if (!deps.isTty()) {
		return {
			ok: false,
			reason:
				"reset-rounds is human-only and stdin/stdout are not a terminal. " +
				"Run it yourself in a shell, or pass --i-am-human to override.",
		};
	}
	const answer = await deps.prompt(`Type the gate key to confirm reset (${gate}): `);
	return answer === gate
		? { ok: true }
		: { ok: false, reason: `confirmation did not match "${gate}"; nothing reset` };
}
