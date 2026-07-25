import { Effect, Layer } from "effect";
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
	foreground?: string[];
	interactive?: InteractiveLaunch | HerdrError;
	failWriteScript?: HerdrError;
	failOpenPane?: HerdrError;
	linkResult?: { ok: boolean; raw: string };
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
			Effect.sync(() => {
				recorder.paneRuns.push({ paneId, command });
			}),

		paneForegroundNames: () => Effect.sync(() => opts.foreground ?? []),

		runInteractivePrompt: (role, cmd, prompt, prefer) =>
			Effect.gen(function* () {
				recorder.interactiveCalls.push({ role, cmd, prompt, prefer });
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
