/**
 * Exercises the real routing in `registerApneaCommands`'s `switch (sub)`:
 * for every verb the registry declares, does the "apnea" command's handler
 * actually reach that verb's case, or does it fall through to the
 * `default: Unknown subcommand` branch?
 *
 * This replaces a tautological test that iterated SUBS — itself derived
 * from OPERATIONS — and asserted it maps back into OPERATIONS, which is
 * true by construction and never touches the switch at all.
 *
 * Several switch cases (resume, abandon, wait, commit, setup) call the real
 * workflow_* functions unconditionally, with no argument guard before the
 * call. Invoking the unmocked handler for those verbs would run real jj/git
 * commits, block on real wait state, or write global config to disk. Every
 * workflow import commands.ts uses is stubbed below so this test is a pure
 * routing check — it proves registry verb reaches switch case, not that the
 * underlying workflow behaves a particular way (that's covered elsewhere,
 * per-workflow).
 *
 * mock.module() must run before commands.ts is loaded, and ES imports are
 * hoisted above any code in the same file — so this file has no top-level
 * `import ... from "./commands.ts"` anywhere; it's loaded via the dynamic
 * import below, after the mocks are installed.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { OPERATIONS } from "../registry.ts";

const stub = async () => ({ ok: true as const, message: "stub" });

mock.module("./start.ts", () => ({ workflowStart: stub }));
mock.module("./status.ts", () => ({
	workflowStatus: stub,
	workflowResetRounds: stub,
}));
mock.module("./commit.ts", () => ({ workflowCommitPhase: stub }));
mock.module("./dispatch.ts", () => ({ workflowDispatch: stub }));
mock.module("./wait.ts", () => ({ workflowWait: stub }));
mock.module("./setup.ts", () => ({ apneaSetup: stub }));

const { registerApneaCommands } = await import("./commands.ts");

afterAll(() => {
	mock.restore();
});

type Notify = (message: string, level?: "info" | "warning" | "error") => void;
type Handler = (
	args: string,
	ctx: { ui: { notify: Notify } },
) => Promise<void>;

/** Fake ExtensionAPI that captures the "apnea" command's handler. */
function captureApneaHandler(): Handler {
	let captured: Handler | undefined;
	const fakePi = {
		registerCommand: (
			name: string,
			options: { handler: Handler },
		) => {
			if (name === "apnea") captured = options.handler;
		},
		sendUserMessage: () => {},
	};
	// Only the slice of ExtensionAPI registerApneaCommands actually calls
	// (registerCommand, sendUserMessage) is implemented above.
	type ExtensionAPIArg = Parameters<typeof registerApneaCommands>[0];
	registerApneaCommands(fakePi as unknown as ExtensionAPIArg);
	if (!captured) throw new Error('"apnea" command was never registered');
	return captured;
}

async function runAndCollect(handler: Handler, args: string) {
	const notifications: string[] = [];
	await handler(args, { ui: { notify: (m) => notifications.push(m) } });
	return notifications;
}

describe("registerApneaCommands dispatch routing", () => {
	test("every registry verb reaches its switch case, not the unknown-subcommand fallback", async () => {
		const handler = captureApneaHandler();
		for (const op of OPERATIONS) {
			const notifications = await runAndCollect(handler, op.verb);
			const hitUnknown = notifications.some((m) =>
				m.startsWith("Unknown subcommand"),
			);
			expect(hitUnknown).toBe(false);
		}
	});

	test("resume and abandon — actions on the start operation, not registry verbs — also route", async () => {
		const handler = captureApneaHandler();
		for (const sub of ["resume", "abandon"]) {
			const notifications = await runAndCollect(handler, sub);
			const hitUnknown = notifications.some((m) =>
				m.startsWith("Unknown subcommand"),
			);
			expect(hitUnknown).toBe(false);
		}
	});

	test("an unregistered verb does fall through to the unknown-subcommand branch", async () => {
		// Sanity check on the assertion itself: prove it can fail before
		// trusting that it passing above means something.
		const handler = captureApneaHandler();
		const notifications = await runAndCollect(handler, "not-a-real-verb");
		expect(notifications.some((m) => m.startsWith("Unknown subcommand"))).toBe(
			true,
		);
	});
});
