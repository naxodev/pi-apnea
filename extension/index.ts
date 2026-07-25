/**
 * @naxodev/apnea — Pi extension tools for Herdr multi-role workflow.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerApneaCommands } from "./commands.ts";
import { toolContent } from "./lib/result.ts";
import type { ToolResult } from "./lib/types.ts";
import { workflowStart } from "./adapters/start.ts";
import { workflowResetRounds, workflowStatus } from "./adapters/status.ts";
import { workflowCommitPhase } from "./tools/commit.ts";
import { workflowDispatch } from "./tools/dispatch.ts";
import { workflowWait } from "./tools/wait.ts";

const DispatchKind = Type.Union([
	Type.Literal("plan"),
	Type.Literal("plan_review"),
	Type.Literal("phase_package"),
	Type.Literal("code"),
	Type.Literal("code_review"),
	Type.Literal("pr_description"),
]);

export default function (pi: ExtensionAPI) {
	// `/apnea …` for humans (autocomplete); tools remain for the model
	registerApneaCommands(pi);

	pi.registerTool({
		name: "workflow_start",
		label: "Apnea start",
		description:
			"Start, resume, or abandon an Apnea run. Start only writes state (step=planning) — it does NOT launch roles. After start succeeds you MUST immediately call dispatch_role kind=plan then workflow_wait. Resume never auto-dispatches. Refuses if state exists or tree dirty (unless allow_dirty).",
		parameters: Type.Object({
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
		async execute(
			_id: string,
			params: {
				goal?: string;
				slug?: string;
				allow_dirty?: boolean;
				action?: "start" | "resume" | "abandon";
			},
		) {
			const action = params.action ?? "start";
			if (action === "start" && !params.goal?.trim()) {
				return toolContent({
					ok: false,
					error: "goal is required when action=start",
				});
			}
			return toolContent(
				await workflowStart({
					goal: params.goal ?? "",
					slug: params.slug,
					allow_dirty: params.allow_dirty,
					action,
				}),
			);
		},
	});

	pi.registerTool({
		name: "dispatch_role",
		label: "Apnea dispatch",
		description:
			"Write task file, open interactive harness TUI in a Herdr pane, wait until idle, submit a short pointer prompt. Never oneshot/-p. Set rework=true only after CHANGES_REQUIRED.",
		parameters: Type.Object({
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
		async execute(
			_id: string,
			params: {
				kind:
					| "plan"
					| "plan_review"
					| "phase_package"
					| "code"
					| "code_review"
					| "pr_description";
				task_markdown?: string;
				rework?: boolean;
			},
		) {
			return toolContent(
				workflowDispatch({
					kind: params.kind,
					task_markdown: params.task_markdown,
					rework: params.rework,
				}),
			);
		},
	});

	pi.registerTool({
		name: "workflow_wait",
		label: "Apnea wait",
		description:
			"Wait for pending artifact front-matter (async; Esc-cancellable). Agent-status is liveness only; shell-only pane without artifact fails fast. Advances state machine on success.",
		parameters: Type.Object({
			timeout_ms: Type.Optional(Type.Number()),
			poll_ms: Type.Optional(Type.Number()),
		}),
		async execute(
			_id: string,
			params: { timeout_ms?: number; poll_ms?: number },
			signal: AbortSignal | undefined,
			onUpdate:
				| ((partial: {
						content: Array<{ type: "text"; text: string }>;
						details: ToolResult;
				  }) => void)
				| undefined,
		) {
			return toolContent(
				await workflowWait(
					{
						timeout_ms: params.timeout_ms,
						poll_ms: params.poll_ms,
					},
					{
						signal,
						onUpdate: onUpdate
							? (partial) => {
									onUpdate({
										content: partial.content,
										details: {
											ok: true,
											message: partial.content[0]?.text ?? "",
										},
									});
								}
							: undefined,
					},
				),
			);
		},
	});

	pi.registerTool({
		name: "workflow_commit_phase",
		label: "Apnea commit",
		description:
			"Require APPROVED code review, run phase package verify commands, jj/git commit, advance phase. Refuses otherwise.",
		parameters: Type.Object({
			message: Type.Optional(Type.String()),
			no_remaining_phases: Type.Optional(
				Type.Boolean({
					description: "If true, go to finishing (PR description) after commit",
				}),
			),
		}),
		async execute(
			_id: string,
			params: { message?: string; no_remaining_phases?: boolean },
		) {
			return toolContent(
				workflowCommitPhase({
					message: params.message,
					no_remaining_phases: params.no_remaining_phases,
				}),
			);
		},
	});

	pi.registerTool({
		name: "workflow_status",
		label: "Apnea status",
		description:
			"Read-only snapshot of run state and legal tools. Never mutates.",
		parameters: Type.Object({}),
		async execute() {
			return toolContent(await workflowStatus());
		},
	});

	pi.registerTool({
		name: "workflow_reset_rounds",
		label: "Apnea reset rounds",
		description:
			"HUMAN ONLY. Reset rework counter for a gate key (e.g. plan_review or phase-01/code_review). Orchestrator must not call this.",
		parameters: Type.Object({
			gate: Type.String({
				description: "Round key, e.g. plan_review or phase-01/code_review",
			}),
		}),
		async execute(_id: string, params: { gate: string }) {
			return toolContent(await workflowResetRounds({ gate: params.gate }));
		},
	});
}
