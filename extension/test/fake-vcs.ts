import { Effect, Layer } from "effect";
import { VcsError } from "../errors.ts";
import type { VcsBackend } from "../lib/types.ts";
import { Vcs, type VcsService } from "../services/vcs.ts";

export type FakeVcsOptions = {
	detect?: VcsBackend | null;
	dirty?: boolean;
	fingerprint?: string;
	verify?: { ok: boolean; log: string };
	commitDetail?: string;
	failCommit?: VcsError | string;
	failEnsureBranch?: VcsError | string;
	ensureBranch?: string;
};

export type FakeVcsRecorder = {
	commits: Array<{ root: string; vcs: VcsBackend; message: string }>;
	bookmarks: Array<{ root: string; slug: string }>;
	verifyRuns: Array<{
		root: string;
		commands: readonly string[];
		timeoutMs: number;
	}>;
	ensureBranches: Array<{ root: string; slug: string }>;
	detectCalls: string[];
	dirtyCalls: Array<{ root: string; vcs: VcsBackend }>;
};

/** Scriptable Vcs layer that records calls for assertions. */
export function fakeVcsLayer(opts: FakeVcsOptions = {}): {
	layer: Layer.Layer<Vcs>;
	recorder: FakeVcsRecorder;
} {
	const recorder: FakeVcsRecorder = {
		commits: [],
		bookmarks: [],
		verifyRuns: [],
		ensureBranches: [],
		detectCalls: [],
		dirtyCalls: [],
	};

	const service: VcsService = {
		detect: (root) =>
			Effect.sync(() => {
				recorder.detectCalls.push(root);
				return opts.detect === undefined ? "jj" : opts.detect;
			}),

		isDirty: (root, vcs) =>
			Effect.sync(() => {
				recorder.dirtyCalls.push({ root, vcs });
				return opts.dirty ?? false;
			}),

		treeFingerprint: (_root, _vcs) =>
			Effect.succeed(opts.fingerprint ?? (opts.dirty ? "M src/x.ts" : "")),

		ensureGitBranch: (root, slug) =>
			Effect.gen(function* () {
				recorder.ensureBranches.push({ root, slug });
				if (opts.failEnsureBranch) {
					const e =
						typeof opts.failEnsureBranch === "string"
							? new VcsError({ message: opts.failEnsureBranch })
							: opts.failEnsureBranch;
					return yield* e;
				}
				return opts.ensureBranch ?? `apnea/${slug}`;
			}),

		commitPhase: (root, vcs, message) =>
			Effect.gen(function* () {
				recorder.commits.push({ root, vcs, message });
				if (opts.failCommit) {
					const e =
						typeof opts.failCommit === "string"
							? new VcsError({ message: opts.failCommit })
							: opts.failCommit;
					return yield* e;
				}
				return (
					opts.commitDetail ??
					(vcs === "jj" ? "jj describe + new" : "git commit")
				);
			}),

		setBookmarkAtTerminus: (root, slug) =>
			Effect.sync(() => {
				recorder.bookmarks.push({ root, slug });
			}),

		runVerify: (root, commands, timeoutMs) =>
			Effect.sync(() => {
				recorder.verifyRuns.push({ root, commands, timeoutMs });
				return opts.verify ?? { ok: true, log: "$ true\nexit=0\n" };
			}),
	};

	return {
		layer: Layer.succeed(Vcs, Vcs.of(service)),
		recorder,
	};
}
