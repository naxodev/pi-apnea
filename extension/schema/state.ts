import { Result, Schema } from "effect";
import { StateCorrupt } from "../errors.ts";
import type { RunState, Step } from "../domain/types.ts";

export const StepSchema = Schema.Literals([
	"planning",
	"plan_review",
	"phase_packaging",
	"coding",
	"code_review",
	"committing",
	"finishing",
	"done",
] as const);

export const VcsBackendSchema = Schema.Literals(["jj", "git"] as const);

export const RoleSchema = Schema.Literals([
	"orchestrator",
	"planner",
	"reviewer",
	"coder",
] as const);

const PaneRefSchema = Schema.Struct({
	pane_id: Schema.String,
	label: Schema.String,
});

/**
 * Runtime codec for `state.json` (version 1).
 * Missing pane-tracking fields are filled in `decodeRunState` (legacy files).
 */
export const RunStateSchema = Schema.Struct({
	version: Schema.Literal(1),
	slug: Schema.String.check(Schema.isMinLength(1)),
	step: StepSchema,
	phase_index: Schema.Number,
	phase_count_hint: Schema.NullOr(Schema.Number),
	rounds: Schema.Record(Schema.String, Schema.Number),
	vcs: VcsBackendSchema,
	allow_dirty: Schema.Boolean,
	goal: Schema.String,
	last_error: Schema.NullOr(Schema.String),
	pending_artifact: Schema.NullOr(Schema.String),
	pending_role: Schema.NullOr(RoleSchema),
	// optional on Encoded so legacy fixtures without pane fields still decode
	pending_pane_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	pending_pane_label: Schema.optionalKey(Schema.NullOr(Schema.String)),
	/** Mirrored in `schemas/state.schema.json`; drift is caught by schema.test.ts. */
	pending_floating_exit: Schema.optionalKey(Schema.NullOr(Schema.String)),
	pending_started_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	pending_deadline_ms: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	pending_nudged_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	pending_final_grace: Schema.optionalKey(Schema.Boolean),
	pending_extended: Schema.optionalKey(Schema.Boolean),
	role_panes: Schema.optionalKey(
		Schema.Record(Schema.String, PaneRefSchema),
	),
	package_root: Schema.String,
	reviewer_tree_fingerprint: Schema.NullOr(Schema.String),
	current_phase_package: Schema.NullOr(Schema.String),
	current_code_review: Schema.NullOr(Schema.String),
});

export type DecodedRunState = typeof RunStateSchema.Type;

export function decodeRunState(
	json: unknown,
	path = "state.json",
): Result.Result<RunState, StateCorrupt> {
	const decoded = Schema.decodeUnknownResult(RunStateSchema)(json);
	if (Result.isFailure(decoded)) {
		return Result.fail(
			new StateCorrupt({
				path,
				message: decoded.failure.message,
			}),
		);
	}
	const d = decoded.success;
	// Backward-compat defaults for state.json files predating pane tracking.
	const state: RunState = {
		version: 1,
		slug: d.slug,
		step: d.step as Step,
		phase_index: d.phase_index,
		phase_count_hint: d.phase_count_hint,
		rounds: { ...d.rounds },
		vcs: d.vcs,
		allow_dirty: d.allow_dirty,
		goal: d.goal,
		last_error: d.last_error,
		pending_artifact: d.pending_artifact,
		pending_role: d.pending_role,
		pending_pane_id: d.pending_pane_id ?? null,
		pending_pane_label: d.pending_pane_label ?? null,
		pending_floating_exit: d.pending_floating_exit ?? null,
		pending_started_at: d.pending_started_at ?? null,
		pending_deadline_ms: d.pending_deadline_ms ?? null,
		pending_nudged_at: d.pending_nudged_at ?? null,
		pending_final_grace: d.pending_final_grace ?? false,
		pending_extended: d.pending_extended ?? false,
		role_panes: { ...(d.role_panes ?? {}) },
		package_root: d.package_root,
		reviewer_tree_fingerprint: d.reviewer_tree_fingerprint,
		current_phase_package: d.current_phase_package,
		current_code_review: d.current_code_review,
	};
	return Result.succeed(state);
}

export type { Step };
