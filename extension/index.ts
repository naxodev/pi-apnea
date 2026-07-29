/**
 * @naxodev/apnea — Pi extension tools for Herdr multi-role workflow.
 *
 * Definitions live in ../registry.ts; this file only binds them to Pi.
 * The CLI (extension/cli/) binds the same registry to argv.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApneaCommands } from "./adapters/commands.ts";
import { OPERATIONS } from "./registry.ts";
import { toolContent } from "./result.ts";
import { workflowWait } from "./adapters/wait.ts";

export default function (pi: ExtensionAPI) {
	// `/apnea …` for humans (autocomplete); tools remain for the model
	registerApneaCommands(pi);

	for (const op of OPERATIONS) {
		if (op.tool === null) continue;

		// wait is the one operation with streaming + abort; Pi's exclusive.
		if (op.tool === "workflow_wait") {
			pi.registerTool({
				name: op.tool,
				label: "Apnea wait",
				description: [op.summary, op.guidance].filter(Boolean).join(" "),
				parameters: op.params,
				async execute(
					_id: string,
					params: { poll_ms?: number; budget_ms?: number },
					signal: AbortSignal | undefined,
					onUpdate:
						| ((partial: {
								content: Array<{ type: "text"; text: string }>;
								details: unknown;
						  }) => void)
						| undefined,
				) {
					return toolContent(
						// Pi blocks in one chunk by design: it streams progress and
						// can be interrupted, so it has no host shell timeout to fit
						// inside. The registry handler no longer injects this — only
						// the CLI reaches that, and it must stay bounded.
						await workflowWait(
							{
								...params,
								budget_ms: params.budget_ms ?? Number.MAX_SAFE_INTEGER,
							},
							{
								signal,
								onUpdate: onUpdate
									? (partial) =>
											onUpdate({
												content: partial.content,
												details: {
													ok: true,
													message: partial.content[0]?.text ?? "",
												},
											})
									: undefined,
							},
						),
					);
				},
			});
			continue;
		}

		pi.registerTool({
			name: op.tool,
			label: `Apnea ${op.verb}`,
			description: [op.summary, op.guidance].filter(Boolean).join(" "),
			parameters: op.params,
			async execute(_id: string, params: Record<string, unknown>) {
				return toolContent(await op.run(params));
			},
		});
	}
}
