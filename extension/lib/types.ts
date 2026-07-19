export type Step =
	| "planning"
	| "plan_review"
	| "phase_packaging"
	| "coding"
	| "code_review"
	| "committing"
	| "finishing"
	| "done";

export type Role = "orchestrator" | "planner" | "reviewer" | "coder";

export type RoleMode = "oneshot" | "interactive";

export type PaneStyle = "regular" | "floating";

export type Verdict = "APPROVED" | "CHANGES_REQUIRED";

export type VcsBackend = "jj" | "git";

export interface Profile {
	cmd_oneshot?: string[];
	cmd_interactive?: string[];
}

export interface RoleBinding {
	profile: string;
}

export interface ApneaConfig {
	profiles: Record<string, Profile>;
	roles: Record<string, RoleBinding>;
	review_round_cap: number;
	timeouts_ms: Record<string, number>;
	pane_style: PaneStyle;
}

export interface RunState {
	version: 1;
	slug: string;
	step: Step;
	phase_index: number;
	phase_count_hint: number | null;
	/** Keys: plan_review | phase-NN/code_review | phase-NN/coding | finishing */
	rounds: Record<string, number>;
	vcs: VcsBackend;
	allow_dirty: boolean;
	goal: string;
	last_error: string | null;
	/** Relative artifact path expected for the in-flight dispatch, if any */
	pending_artifact: string | null;
	/** Role for pending dispatch */
	pending_role: Role | null;
	/** Herdr pane id for the in-flight dispatch */
	pending_pane_id: string | null;
	/** Label of that pane (apnea:role:unique) */
	pending_pane_label: string | null;
	/**
	 * Last known live pane per role, keyed by role name.
	 * Reuse is by pane_id only (never by scanning ambiguous labels).
	 */
	role_panes: Partial<Record<Role, { pane_id: string; label: string }>>;
	/** Absolute path to package root (briefs) */
	package_root: string;
	/** Tree snapshot fingerprint before reviewer dispatch */
	reviewer_tree_fingerprint: string | null;
	/** Last known phase package path for verify/commit */
	current_phase_package: string | null;
	/** Last code-review path for commit gate */
	current_code_review: string | null;
}

export interface FrontMatter {
	status?: string;
	verdict?: string;
	nits?: string;
	raw: string;
	body: string;
}

export interface ToolOk {
	ok: true;
	message: string;
	data?: Record<string, unknown>;
}

export interface ToolErr {
	ok: false;
	error: string;
	legal_next?: string[];
	data?: Record<string, unknown>;
}

export type ToolResult = ToolOk | ToolErr;

/**
 * All worker roles use interactive TUIs so you can watch them live in Herdr.
 * Oneshot (`claude -p`, `pi -p`) is intentionally not used for dispatch:
 * it dumps shell output and is not observable as a harness session.
 */
export const ROLE_MODE: Record<Role, RoleMode> = {
	orchestrator: "interactive",
	planner: "interactive",
	reviewer: "interactive",
	coder: "interactive",
};

export const DEFAULT_TIMEOUTS: Record<string, number> = {
	planning: 1_500_000,
	plan_review: 900_000,
	phase_packaging: 900_000,
	coding: 2_700_000,
	code_review: 900_000,
	verify: 900_000,
	finishing: 900_000,
	default: 900_000,
};
