import { describe, expect } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { statePath } from "../domain/paths.ts";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { itEffect } from "../test/it-effect.ts";
import { RunStore, RunStoreLive } from "./run-store.ts";

function withFake(initial: Record<string, string> = {}) {
	const fake = makeFakeFileSystem(initial);
	const layer = Layer.provideMerge(RunStoreLive, fake.layer);
	return { fake, layer };
}

const sampleState = {
	version: 1 as const,
	slug: "demo",
	step: "planning" as const,
	phase_index: 1,
	phase_count_hint: null,
	rounds: {},
	vcs: "jj" as const,
	allow_dirty: false,
	goal: "g",
	last_error: null,
	pending_artifact: null,
	pending_role: null,
	pending_pane_id: null,
	pending_pane_label: null,
	pending_floating_exit: null,
	pending_started_at: null,
	pending_deadline_ms: null,
	pending_nudged_at: null,
	pending_extended: false,
	role_panes: {},
	package_root: "/pkg",
	reviewer_tree_fingerprint: null,
	current_phase_package: null,
	current_code_review: null,
};

describe("RunStore (fake FileSystem)", () => {
	itEffect("load returns null when missing", () => {
		const { layer } = withFake();
		return Effect.gen(function* () {
			const store = yield* RunStore;
			const s = yield* store.load("/proj");
			expect(s).toBeNull();
		}).pipe(Effect.provide(layer));
	});

	itEffect("legacy state without pane fields decodes with defaults", () => {
		const root = "/proj";
		const p = statePath(root);
		const legacy = {
			version: 1,
			slug: "old",
			step: "planning",
			phase_index: 1,
			phase_count_hint: null,
			rounds: {},
			vcs: "git",
			allow_dirty: true,
			goal: "g",
			last_error: null,
			pending_artifact: null,
			pending_role: null,
			package_root: "/x",
			reviewer_tree_fingerprint: null,
			current_phase_package: null,
			current_code_review: null,
		};
		const { layer } = withFake({ [p]: JSON.stringify(legacy) });
		return Effect.gen(function* () {
			const store = yield* RunStore;
			const s = yield* store.load(root);
			expect(s).not.toBeNull();
			expect(s!.pending_pane_id).toBeNull();
			expect(s!.pending_pane_label).toBeNull();
			expect(s!.pending_floating_exit).toBeNull();
			expect(s!.role_panes).toEqual({});
		}).pipe(Effect.provide(layer));
	});

	itEffect("garbage JSON → StateCorrupt", () => {
		const root = "/proj";
		const p = statePath(root);
		const { layer } = withFake({ [p]: "{not json" });
		return Effect.gen(function* () {
			const store = yield* RunStore;
			const exit = yield* Effect.exit(store.load(root));
			expect(Exit.isFailure(exit)).toBe(true);
		}).pipe(Effect.provide(layer));
	});

	itEffect("version: 2 → StateCorrupt", () => {
		const root = "/proj";
		const p = statePath(root);
		const { layer } = withFake({
			[p]: JSON.stringify({ ...sampleState, version: 2 }),
		});
		return Effect.gen(function* () {
			const store = yield* RunStore;
			const exit = yield* Effect.exit(store.load(root));
			expect(Exit.isFailure(exit)).toBe(true);
		}).pipe(Effect.provide(layer));
	});

	itEffect("save writes trailing newline", () => {
		const root = "/proj";
		const { fake, layer } = withFake();
		return Effect.gen(function* () {
			const store = yield* RunStore;
			yield* store.save(sampleState, root);
			const body = fake.files.get(statePath(root));
			expect(body).toBeDefined();
			expect(body!.endsWith("\n")).toBe(true);
			expect(body).toBe(`${JSON.stringify(sampleState, null, 2)}\n`);
		}).pipe(Effect.provide(layer));
	});

	itEffect("abandon renames and fails NoRunState when missing", () => {
		const root = "/proj";
		const { fake, layer } = withFake({
			[statePath(root)]: `${JSON.stringify(sampleState, null, 2)}\n`,
		});
		return Effect.gen(function* () {
			const store = yield* RunStore;
			const bak = yield* store.abandon(root);
			expect(bak).toContain("state.json.abandoned.");
			expect(fake.files.has(statePath(root))).toBe(false);
			expect(fake.files.has(bak)).toBe(true);

			const exit = yield* Effect.exit(store.abandon(root));
			expect(Exit.isFailure(exit)).toBe(true);
		}).pipe(Effect.provide(layer));
	});

	itEffect("abandon succeeds on corrupt state.json without decoding", () => {
		const root = "/proj";
		const p = statePath(root);
		const { fake, layer } = withFake({ [p]: "{not valid json" });
		return Effect.gen(function* () {
			const store = yield* RunStore;
			const bak = yield* store.abandon(root);
			expect(bak).toContain("state.json.abandoned.");
			expect(fake.files.has(p)).toBe(false);
			expect(fake.files.has(bak)).toBe(true);
			expect(fake.files.get(bak)).toBe("{not valid json");
		}).pipe(Effect.provide(layer));
	});

	itEffect("require fails NoRunState when missing", () => {
		const { layer } = withFake();
		return Effect.gen(function* () {
			const store = yield* RunStore;
			const exit = yield* Effect.exit(store.require("/empty"));
			expect(Exit.isFailure(exit)).toBe(true);
		}).pipe(Effect.provide(layer));
	});
});
