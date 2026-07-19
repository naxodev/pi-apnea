import * as fs from "node:fs";
import { loadConfig } from "../lib/config.ts";
import {
	ensureApneaDirs,
	packageRoot,
	projectConfigPath,
	statePath,
} from "../lib/paths.ts";
import { err, ok } from "../lib/result.ts";
import { loadState, saveState } from "../lib/state.ts";
import type { RunState, ToolResult } from "../lib/types.ts";
import { detectVcs, isDirty } from "../lib/vcs.ts";
import { ensureGitBranch } from "../lib/vcs.ts";

function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || "run"
	);
}

export function workflowStart(params: {
	goal: string;
	slug?: string;
	allow_dirty?: boolean;
	action?: "start" | "resume" | "abandon";
}): ToolResult {
	const root = process.cwd();
	const action = params.action ?? "start";
	const existing = loadState(root);

	if (action === "abandon") {
		if (!existing) return err("no state to abandon");
		const bak = `${statePath(root)}.abandoned.${Date.now()}`;
		fs.renameSync(statePath(root), bak);
		return ok(`abandoned run; state moved to ${bak}`, { backup: bak });
	}

	if (action === "resume") {
		if (!existing) return err("no state to resume");
		// Never auto-dispatch; report reconcile info
		const pending = existing.pending_artifact;
		let pendingStatus: string = "none";
		if (pending) {
			const abs = pending.startsWith("/") ? pending : `${root}/${pending}`;
			pendingStatus = fs.existsSync(abs)
				? "artifact_exists"
				: "artifact_missing";
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
		return err(
			`state.json already exists (step=${existing.step}). Use action=resume or action=abandon.`,
			{ data: { step: existing.step, slug: existing.slug } },
		);
	}

	let cfg;
	try {
		cfg = loadConfig(root);
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}

	const vcs = detectVcs(root);
	if (!vcs) {
		return err("no .jj or .git — refuse auto-commit setup (init vcs first)");
	}

	const allowDirty = params.allow_dirty === true;
	if (!allowDirty && isDirty(root, vcs)) {
		return err(
			"working tree is dirty (file content). Commit/clean first, or pass allow_dirty=true",
		);
	}

	const slug = params.slug?.trim() || slugify(params.goal);
	ensureApneaDirs(root);

	if (vcs === "git") {
		try {
			ensureGitBranch(root, slug);
		} catch (e) {
			return err(e instanceof Error ? e.message : String(e));
		}
	}

	// project config may already exist; do not invent cmds
	if (!fs.existsSync(projectConfigPath(root))) {
		// optional empty bindings file is fine to skip
	}

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
		role_panes: {},
		package_root: packageRoot(),
		reviewer_tree_fingerprint: null,
		current_phase_package: null,
		current_code_review: null,
	};
	saveState(state, root);

	return ok(`started run slug=${slug} vcs=${vcs} step=planning`, {
		state,
		profiles: Object.keys(cfg.profiles),
		roles: cfg.roles,
		note: "spawn role panes on first dispatch_role; cold roles use oneshot scripts",
	});
}
