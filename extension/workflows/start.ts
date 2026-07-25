import { Effect } from "effect";
import { packageRoot, projectConfigPath } from "../domain/paths.ts";
import { slugify } from "../domain/slug.ts";
import {
	ConfigError,
	GateRefused,
	NoRunState,
	VcsError,
	type AppError,
} from "../errors.ts";
import { loadConfig } from "../lib/config.ts";
import type { RunState } from "../lib/types.ts";
import { detectVcs, ensureGitBranch, isDirty } from "../lib/vcs.ts";
import { ok, type ToolResult } from "../result.ts";
import { FileSystem } from "../services/file-system.ts";
import { RunStore } from "../services/run-store.ts";

export type StartParams = {
	goal: string;
	slug?: string;
	allow_dirty?: boolean;
	action?: "start" | "resume" | "abandon";
};

/**
 * Start / resume / abandon an Apnea run.
 * Refusals are tagged failures only — never ok:false ToolResults.
 */
export const startWorkflow = (
	params: StartParams,
	root: string,
): Effect.Effect<ToolResult, AppError, FileSystem | RunStore> =>
	Effect.gen(function* () {
		const store = yield* RunStore;
		const fs = yield* FileSystem;
		const action = params.action ?? "start";

		if (action === "abandon") {
			const bak = yield* store.abandon(root);
			return ok(`abandoned run; state moved to ${bak}`, { backup: bak });
		}

		const existing = yield* store.load(root);

		if (action === "resume") {
			if (!existing) return yield* new NoRunState({});
			// Never auto-dispatch; report reconcile info
			const pending = existing.pending_artifact;
			let pendingStatus: string = "none";
			if (pending) {
				const absPath = pending.startsWith("/")
					? pending
					: `${root}/${pending}`;
				const present = yield* fs.exists(absPath);
				pendingStatus = present ? "artifact_exists" : "artifact_missing";
			}
			return ok("resume: re-resolve panes by label; do not auto-dispatch", {
				state: existing,
				pending_status: pendingStatus,
				hint:
					pendingStatus === "artifact_exists"
						? "call workflow_wait to ingest pending artifact"
						: pendingStatus === "artifact_missing"
							? "offer re-dispatch same round via dispatch_role"
							: "inspect workflow_status and continue legal next step",
			});
		}

		// start
		if (existing) {
			return yield* new GateRefused({
				gate: "start",
				message: `state.json already exists (step=${existing.step}). Use action=resume or action=abandon.`,
				details: { step: existing.step, slug: existing.slug },
			});
		}

		// Phase 3: Config/Vcs service
		const cfg = yield* Effect.try({
			try: () => loadConfig(root),
			catch: (e) =>
				new ConfigError({
					message: e instanceof Error ? e.message : String(e),
				}),
		});

		// Phase 3: Config/Vcs service
		const vcs = detectVcs(root);
		if (!vcs) {
			return yield* new VcsError({
				message: "no .jj or .git — refuse auto-commit setup (init vcs first)",
			});
		}

		const allowDirty = params.allow_dirty === true;
		// Phase 3: Config/Vcs service
		if (!allowDirty && isDirty(root, vcs)) {
			return yield* new GateRefused({
				gate: "clean_tree",
				message:
					"working tree is dirty (file content). Commit/clean first, or pass allow_dirty=true",
			});
		}

		const slug = params.slug?.trim() || slugify(params.goal);

		if (vcs === "git") {
			// Phase 3: Config/Vcs service
			yield* Effect.try({
				try: () => {
					ensureGitBranch(root, slug);
				},
				catch: (e) =>
					new VcsError({
						message: e instanceof Error ? e.message : String(e),
					}),
			});
		}

		// project config may already exist; do not invent cmds
		yield* fs.exists(projectConfigPath(root));
		// optional empty bindings file is fine to skip

		const state: RunState = {
			version: 1,
			slug,
			step: "planning",
			phase_index: 1,
			phase_count_hint: null,
			rounds: {},
			vcs,
			allow_dirty: allowDirty,
			goal: params.goal,
			last_error: null,
			pending_artifact: null,
			pending_role: null,
			pending_pane_id: null,
			pending_pane_label: null,
			pending_floating_exit: null,
			role_panes: {},
			package_root: packageRoot(),
			reviewer_tree_fingerprint: null,
			current_phase_package: null,
			current_code_review: null,
		};
		yield* store.save(state, root);

		return ok(
			`started run slug=${slug} vcs=${vcs} step=planning. NEXT: dispatch_role kind=plan, then workflow_wait.`,
			{
				state,
				profiles: Object.keys(cfg.profiles),
				roles: cfg.roles,
				next: "dispatch_role",
				next_args: { kind: "plan" },
				legal_next: ["dispatch_role", "workflow_status"],
				note: "start only writes state — it does not launch roles. Orchestrator must dispatch plan immediately.",
			},
		);
	});
