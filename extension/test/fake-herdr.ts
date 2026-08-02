import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HerdrError } from "../errors.ts";
import {
	Herdr,
	type HerdrService,
	type InteractiveLaunch,
	type PaneInfo,
	type RolePaneRef,
} from "../services/herdr.ts";

export type FakeHerdrOptions = {
	enabled?: boolean;
	version?: [number, number, number] | null;
	hasPlugin?: boolean;
	/** Function so a test can flip a pane's status between polls. */
	pane?: (paneId: string) => PaneInfo;
	/** Function so a test can flip the foreground process list between polls,
	 * the same way `pane` already does for status. */
	foreground?: string[] | (() => string[]);
	interactive?: InteractiveLaunch | HerdrError;
	failWriteScript?: HerdrError;
	failOpenPane?: HerdrError;
	linkResult?: { ok: boolean; raw: string };
	/**
	 * `paneRun` fails with this error. The send is still recorded in
	 * `recorder.paneRuns` first — a real failed `herdr pane run` still reaches
	 * the pane, so a test needs to tell "attempted but failed" apart from
	 * "never attempted" (e.g. `tryNudge` in wait.ts must not skip the attempt).
	 */
	failPaneRun?: HerdrError;
	/**
	 * Advances the `TestClock` by this many ms before `runInteractivePrompt`
	 * returns, modelling the real `waitAgentReady` block (services/herdr.ts,
	 * up to 90s) so a test can assert what a slow interactive launch does to
	 * clock-anchored fields (`pending_started_at`, `pending_deadline_ms`).
	 * Requires the caller's layer to include `TestClock.layer()`.
	 */
	interactiveDelayMs?: number;
};

export type FakeHerdrRecorder = {
	paneRuns: Array<{ paneId: string; command: string }>;
	scripts: Array<{
		scriptAbs: string;
		cmd: string[];
		prompt: string;
		exitFileAbs: string;
	}>;
	openedPanes: string[];
	interactiveCalls: Array<{
		role: string;
		cmd: string[];
		prompt: string;
		prefer: RolePaneRef | null;
	}>;
	linkedPlugins: string[];
};

/** Scriptable Herdr layer that records calls for assertions. */
export function fakeHerdrLayer(opts: FakeHerdrOptions = {}): {
	layer: Layer.Layer<Herdr>;
	recorder: FakeHerdrRecorder;
} {
	const recorder: FakeHerdrRecorder = {
		paneRuns: [],
		scripts: [],
		openedPanes: [],
		interactiveCalls: [],
		linkedPlugins: [],
	};

	const service: HerdrService = {
		enabled: Effect.sync(() => opts.enabled ?? true),

		version: Effect.sync(() =>
			opts.version === undefined ? [0, 7, 4] : opts.version,
		),

		hasApneaPlugin: Effect.sync(() => opts.hasPlugin ?? true),

		paneGet: (paneId) =>
			Effect.sync(() =>
				opts.pane ? opts.pane(paneId) : { ok: true, agent_status: "idle" },
			),

		paneRun: (paneId, command) =>
			Effect.gen(function* () {
				// Recorded before the failure check: a real `herdr pane run` still
				// reaches the pane even when the CLI call itself fails, so a caller
				// that only checks "was it attempted" (not "did it succeed") must see
				// the attempt either way.
				recorder.paneRuns.push({ paneId, command });
				if (opts.failPaneRun) {
					return yield* opts.failPaneRun;
				}
			}),

		paneForegroundNames: () =>
			Effect.sync(() =>
				(typeof opts.foreground === "function"
					? opts.foreground()
					: opts.foreground) ?? [],
			),

		runInteractivePrompt: (role, cmd, prompt, prefer) =>
			Effect.gen(function* () {
				recorder.interactiveCalls.push({ role, cmd, prompt, prefer });
				if (opts.interactiveDelayMs) {
					// Models the real `waitAgentReady` block inside
					// `runInteractivePrompt` (services/herdr.ts) so a test can assert
					// what a slow launch does to clock-anchored state.
					yield* TestClock.adjust(opts.interactiveDelayMs);
				}
				if (opts.interactive instanceof HerdrError) {
					return yield* opts.interactive;
				}
				return (
					opts.interactive ?? {
						pane_id: "pane-1",
						label: `apnea:${role}:fake`,
						reused: false,
						prompt_accepted: true,
						prompt_attempts: 1,
						last_status: "working",
					}
				);
			}),

		writeFloatingTaskScript: (scriptAbs, _root, cmd, prompt, exitFileAbs) =>
			Effect.gen(function* () {
				if (opts.failWriteScript) {
					return yield* opts.failWriteScript;
				}
				recorder.scripts.push({ scriptAbs, cmd, prompt, exitFileAbs });
			}),

		openFloatingPane: (taskScriptAbs) =>
			Effect.gen(function* () {
				if (opts.failOpenPane) {
					return yield* opts.failOpenPane;
				}
				recorder.openedPanes.push(taskScriptAbs);
			}),

		linkPlugin: (dir) =>
			Effect.sync(() => {
				recorder.linkedPlugins.push(dir);
				return opts.linkResult ?? { ok: true, raw: "linked" };
			}),
	};

	return {
		layer: Layer.succeed(Herdr, Herdr.of(service)),
		recorder,
	};
}
