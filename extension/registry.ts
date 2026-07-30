import { Type, type TSchema } from "typebox";
import { workflowCommitPhase } from "./adapters/commit.ts";
import { workflowDispatch } from "./adapters/dispatch.ts";
import { apneaSetup } from "./adapters/setup.ts";
import { workflowStart } from "./adapters/start.ts";
import { workflowResetRounds, workflowStatus } from "./adapters/status.ts";
import { workflowWait } from "./adapters/wait.ts";
import { DISPATCH_KINDS } from "./domain/state-machine.ts";
import type { ToolResult } from "./result.ts";
import type { WaitParams } from "./workflows/wait.ts";

export type Operation = {
	/** Pi tool name, or null when the operation is not model-facing. */
	readonly tool: string | null;
	/** CLI verb and `/apnea` subcommand. */
	readonly verb: string;
	/**
	 * Argument syntax shown next to the verb in `/apnea help`, e.g.
	 * `"<goal> [--allow-dirty] [--slug=name]"`. Empty string for verbs that
	 * take no arguments (e.g. `status`). Required so a new operation can't
	 * silently omit the human-facing usage the old hand-written helpText()
	 * used to carry.
	 */
	readonly usage: string;
	/** One line, shared by the tool description and `--help`. */
	readonly summary: string;
	/** Extra prose for the model only; omitted from `--help`. */
	readonly guidance?: string;
	readonly params: TSchema;
	/** Gated behind the TTY check in the CLI; never registered as a tool. */
	readonly humanOnly?: true;
	readonly run: (params: Record<string, unknown>) => Promise<ToolResult>;
};

// Sourced from domain/state-machine.ts (not hardcoded here) so a new kind
// added there can't silently drift out of sync with the registry — the same
// pattern extension/index.ts already uses.
const DispatchKind = Type.Union(
	DISPATCH_KINDS.map((kind) => Type.Literal(kind)),
);

// Workflow order, not alphabetical or tool-name order: setup is the natural
// first step for a new checkout, then the start → dispatch → wait → commit
// loop, then the always-available status, then the human-only escape hatch.
// `/apnea help` and autocomplete (SUBS) both derive their order from this
// array, so ordering it once here keeps every rendering in sync for free.
export const OPERATIONS: readonly Operation[] = [
	{
		tool: null,
		verb: "setup",
		usage: "[--project] [--force] [--agents-md]",
		summary: "Write global profiles and optional project role bindings.",
		params: Type.Object({
			project: Type.Optional(Type.Boolean()),
			force: Type.Optional(Type.Boolean()),
			agents_md: Type.Optional(Type.Boolean()),
		}),
		run: (p) => apneaSetup(p as Parameters<typeof apneaSetup>[0]),
	},
	{
		tool: "workflow_start",
		verb: "start",
		usage: "<goal> [--allow-dirty] [--slug=name]",
		summary: "Start, resume, or abandon an Apnea run.",
		guidance:
			"Start only writes state (step=planning) — it does NOT launch roles. After start succeeds you MUST immediately call dispatch_role kind=plan then workflow_wait. Resume never auto-dispatches. Refuses if state exists or tree dirty (unless allow_dirty).",
		params: Type.Object({
			goal: Type.Optional(
				Type.String({ description: "Run goal (required for action=start)" }),
			),
			slug: Type.Optional(
				Type.String({ description: "Run slug for branch/bookmark" }),
			),
			allow_dirty: Type.Optional(Type.Boolean()),
			action: Type.Optional(
				Type.Union([
					Type.Literal("start"),
					Type.Literal("resume"),
					Type.Literal("abandon"),
				]),
			),
		}),
		// Mirrors the guard in index.ts's execute(): without it, action=start
		// with no goal reaches slugify(undefined) in workflows/start.ts and
		// throws instead of returning a clean refusal.
		run: (p) => {
			const params = p as Parameters<typeof workflowStart>[0];
			const action = params.action ?? "start";
			if (action === "start" && !params.goal?.trim()) {
				return Promise.resolve({
					ok: false,
					error: "goal is required when action=start",
				});
			}
			return workflowStart({
				goal: params.goal ?? "",
				slug: params.slug,
				allow_dirty: params.allow_dirty,
				action,
			});
		},
	},
	{
		tool: "dispatch_role",
		verb: "dispatch",
		usage: "<kind> [--rework]",
		summary: "Write the task file and launch a role in a Herdr pane.",
		guidance:
			"One outstanding dispatch at a time. Pass rework=true only after CHANGES_REQUIRED on the same gate — that is what increments the round counter.",
		params: Type.Object({
			kind: DispatchKind,
			task_markdown: Type.Optional(
				Type.String({ description: "Extra task body details" }),
			),
			rework: Type.Optional(
				Type.Boolean({
					description: "Increment round after CHANGES_REQUIRED",
				}),
			),
		}),
		run: (p) => workflowDispatch(p as Parameters<typeof workflowDispatch>[0]),
	},
	{
		tool: "workflow_wait",
		verb: "wait",
		usage: "[--poll=<ms>] [--budget=<ms>|--timeout=<ms>]",
		summary: "Wait for the pending artifact's front-matter to be complete.",
		guidance:
			"Blocks until the artifact is ready or the role times out. Exit is non-fatal when the call's budget is spent but the role still has time — call again.",
		// `timeout_ms` was dropped in Task 3: dispatch always stamps the deadline,
		// so it no-opped for every real run. The role timeout lives in config.
		params: Type.Object({
			poll_ms: Type.Optional(Type.Number()),
			budget_ms: Type.Optional(Type.Number()),
		}),
		// The Pi driver bypasses this handler entirely — Task 5 special-cases
		// workflow_wait and calls workflowWait directly with its own streaming
		// hooks, supplying its own budget (see extension/index.ts). This run is
		// reached only by the CLI, which must not block forever, so params pass
		// through unchanged and DEFAULT_BUDGET_MS (300s) applies when budget_ms
		// is absent. No hooks parameter here — nothing calls op.run with one.
		run: (p) => workflowWait(p as WaitParams),
	},
	{
		tool: "workflow_commit_phase",
		verb: "commit",
		usage: "[--done] [message]",
		summary: "Verify and commit the current phase, then advance.",
		guidance:
			"Requires an APPROVED code review. Runs the phase package's verify commands and refuses on non-zero exit. Pass no_remaining_phases=true to move to the PR description instead of the next phase.",
		params: Type.Object({
			message: Type.Optional(Type.String()),
			no_remaining_phases: Type.Optional(
				Type.Boolean({
					description: "If true, go to finishing (PR description) after commit",
				}),
			),
		}),
		run: (p) =>
			workflowCommitPhase(p as Parameters<typeof workflowCommitPhase>[0]),
	},
	{
		tool: "workflow_status",
		verb: "status",
		usage: "",
		summary: "Read-only snapshot of run state and legal next calls.",
		guidance: "Never mutates. Safe to call at any point.",
		params: Type.Object({}),
		run: () => workflowStatus(),
	},
	{
		tool: null,
		verb: "reset-rounds",
		// `--i-am-human` is deliberately not listed here: it's a CLI-only TTY
		// bypass (the slash handler doesn't accept it — see main.ts's own usage()
		// and README.md), and this string feeds both `/apnea help` and the CLI's
		// per-verb line, so listing it here would advertise it on the slash
		// command too.
		usage: "<gate>",
		summary: "Reset the rework counter for a gate. Human only.",
		humanOnly: true,
		params: Type.Object({
			gate: Type.String({
				description: "Round key, e.g. plan_review or phase-01/code_review",
			}),
		}),
		run: (p) =>
			workflowResetRounds(p as Parameters<typeof workflowResetRounds>[0]),
	},
];

export function findByVerb(verb: string): Operation | undefined {
	return OPERATIONS.find((o) => o.verb === verb);
}

export function findByTool(tool: string): Operation | undefined {
	return OPERATIONS.find((o) => o.tool === tool);
}

/** Canonical tool name → CLI verb, or null when not model-facing. */
export function toolToVerb(tool: string): string | null {
	return findByTool(tool)?.verb ?? null;
}
