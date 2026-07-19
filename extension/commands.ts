/**
 * User-facing slash commands with `/` autocomplete.
 * These call the same functions as the LLM tools — no workflow_* typing required.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatResult } from "./lib/result.ts";
import { apneaSetup } from "./lib/setup.ts";
import type { DispatchKind } from "./lib/state-machine.ts";
import type { ToolResult } from "./lib/types.ts";
import { workflowCommitPhase } from "./tools/commit.ts";
import { workflowDispatch } from "./tools/dispatch.ts";
import { workflowStart } from "./tools/start.ts";
import { workflowResetRounds, workflowStatus } from "./tools/status.ts";
import { workflowWait } from "./tools/wait.ts";

const SUBS = [
	"setup",
	"start",
	"resume",
	"abandon",
	"status",
	"dispatch",
	"wait",
	"commit",
	"reset-rounds",
	"help",
] as const;

const DISPATCH_KINDS: DispatchKind[] = [
	"plan",
	"plan_review",
	"phase_package",
	"code",
	"code_review",
	"pr_description",
];

function notify(
	ctx: {
		ui: { notify: (m: string, l?: "info" | "error" | "warning") => void };
	},
	r: ToolResult,
) {
	const text = formatResult(r);
	ctx.ui.notify(text, r.ok ? "info" : "error");
}

function orchestratorKickMessage(
	kind: "start" | "resume",
	goal?: string,
): string {
	if (kind === "start") {
		return [
			"You are the Apnea orchestrator for this run. Schedule only — no product code.",
			goal ? `Goal: ${goal}` : null,
			"State is step=planning with no pending dispatch.",
			'Immediately call dispatch_role with kind="plan", then workflow_wait.',
			"Then continue the loop: plan_review → phase_package → code → code_review → workflow_commit_phase → … → pr_description.",
			"Use workflow_status if unsure. Never call workflow_reset_rounds. Escalate timeouts/caps/dirty-reviewer to the human.",
		]
			.filter(Boolean)
			.join("\n");
	}
	return [
		"You are the Apnea orchestrator resuming this run. Schedule only — no product code.",
		"Call workflow_status (and workflow_start action=resume if needed).",
		"If a pending artifact exists, workflow_wait. Else dispatch the legal kind for the current step.",
		"Never auto-invent steps; never workflow_reset_rounds; never product code.",
	].join("\n");
}

function parseFlags(tokens: string[]): { flags: Set<string>; rest: string[] } {
	const flags = new Set<string>();
	const rest: string[] = [];
	for (const t of tokens) {
		if (t.startsWith("--")) flags.add(t.slice(2));
		else rest.push(t);
	}
	return { flags, rest };
}

function helpText(): string {
	return [
		"Apnea commands (tools remain for the model; you use /apnea):",
		"  /apnea setup [--project] [--force]   # global profiles; optional project bindings",
		"  /apnea start <goal> [--allow-dirty] [--slug=name]",
		"  /apnea resume | abandon | status | wait",
		"  /apnea dispatch <kind> [--rework]",
		"      kinds: plan | plan_review | phase_package | code | code_review | pr_description",
		"  /apnea commit [--done] [message]",
		"  /apnea reset-rounds <gate>   (human only; e.g. plan_review or phase-01/code_review)",
		"  /apnea help",
	].join("\n");
}

export function registerApneaCommands(pi: ExtensionAPI): void {
	const kick = (kind: "start" | "resume", goal?: string) => {
		pi.sendUserMessage(orchestratorKickMessage(kind, goal));
	};

	pi.registerCommand("apnea", {
		description: "Apnea workflow: start, status, dispatch, wait, commit, …",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.trimStart().split(/\s+/);
			// completing first token (subcommand)
			if (parts.length <= 1) {
				const p = parts[0] ?? "";
				const hits = SUBS.filter((s) => s.startsWith(p)).map((s) => ({
					value: s,
					label: s,
				}));
				return hits.length ? hits : null;
			}
			const sub = parts[0];
			if (sub === "dispatch") {
				const p = parts[1] ?? "";
				const hits = DISPATCH_KINDS.filter((k) => k.startsWith(p)).map((k) => ({
					value: `${sub} ${k}`.slice(sub.length + 1), // complete kind only? Pi may replace last token
					label: k,
				}));
				// Prefer completing just the kind token
				const kindHits = DISPATCH_KINDS.filter((k) => k.startsWith(p)).map(
					(k) => ({
						value: k,
						label: k,
					}),
				);
				return kindHits.length ? kindHits : hits.length ? hits : null;
			}
			if (sub === "setup") {
				const p = parts[1] ?? "";
				const flags = ["--project", "--force"];
				const hits = flags
					.filter((f) => f.startsWith(p) || p === "")
					.map((f) => ({ value: f, label: f }));
				return hits.length ? hits : null;
			}
			if (sub === "start" && parts.length === 2 && parts[1]?.startsWith("--")) {
				const flags = ["--allow-dirty", "--slug="];
				const p = parts[1] ?? "";
				const hits = flags
					.filter((f) => f.startsWith(p))
					.map((f) => ({ value: f, label: f }));
				return hits.length ? hits : null;
			}
			if (sub === "commit") {
				const p = parts[1] ?? "";
				if (p.startsWith("-") || p === "") {
					const hits = ["--done"]
						.filter((f) => f.startsWith(p) || p === "")
						.map((f) => ({ value: f, label: f }));
					return hits.length ? hits : null;
				}
			}
			if (sub === "reset-rounds") {
				const gates = [
					"plan_review",
					"phase-01/code_review",
					"phase-02/code_review",
				];
				const p = parts[1] ?? "";
				const hits = gates
					.filter((g) => g.startsWith(p))
					.map((g) => ({ value: g, label: g }));
				return hits.length ? hits : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw || raw === "help") {
				ctx.ui.notify(helpText(), "info");
				return;
			}

			const tokens = raw.split(/\s+/).filter(Boolean);
			const sub = tokens[0]!;
			const { flags, rest } = parseFlags(tokens.slice(1));

			try {
				switch (sub) {
					case "help":
						ctx.ui.notify(helpText(), "info");
						return;

					case "setup":
						notify(
							ctx,
							apneaSetup({
								project: flags.has("project") || tokens.includes("--project"),
								force: flags.has("force") || tokens.includes("--force"),
							}),
						);
						return;

					case "start": {
						// goal is everything not a flag; support --slug=x
						let slug: string | undefined;
						const goalParts: string[] = [];
						for (const t of tokens.slice(1)) {
							if (t.startsWith("--slug=")) slug = t.slice("--slug=".length);
							else if (t === "--allow-dirty") continue;
							else if (t.startsWith("--")) continue;
							else goalParts.push(t);
						}
						const goal = goalParts.join(" ").trim();
						if (!goal) {
							ctx.ui.notify(
								"Usage: /apnea start <goal> [--allow-dirty] [--slug=name]",
								"error",
							);
							return;
						}
						const r = workflowStart({
							goal,
							slug,
							allow_dirty:
								flags.has("allow-dirty") || tokens.includes("--allow-dirty"),
							action: "start",
						});
						notify(ctx, r);
						if (r.ok) kick("start", goal);
						return;
					}

					case "resume": {
						const r = workflowStart({ goal: "", action: "resume" });
						notify(ctx, r);
						if (r.ok) kick("resume");
						return;
					}

					case "abandon":
						notify(ctx, workflowStart({ goal: "", action: "abandon" }));
						return;

					case "status":
						notify(ctx, workflowStatus());
						return;

					case "wait": {
						const timeoutTok = rest.find((t) => t.startsWith("--timeout="));
						const timeout_ms = timeoutTok
							? Number(timeoutTok.slice("--timeout=".length))
							: undefined;
						const r = await workflowWait({ timeout_ms });
						notify(ctx, r);
						return;
					}

					case "dispatch": {
						const kind = rest[0] as DispatchKind | undefined;
						if (!kind || !DISPATCH_KINDS.includes(kind)) {
							ctx.ui.notify(
								`Usage: /apnea dispatch <${DISPATCH_KINDS.join("|")}> [--rework]`,
								"error",
							);
							return;
						}
						notify(
							ctx,
							workflowDispatch({
								kind,
								rework: flags.has("rework") || tokens.includes("--rework"),
							}),
						);
						return;
					}

					case "commit": {
						const message =
							rest
								.filter((t) => !t.startsWith("--"))
								.join(" ")
								.trim() || undefined;
						notify(
							ctx,
							workflowCommitPhase({
								message,
								no_remaining_phases:
									flags.has("done") || tokens.includes("--done"),
							}),
						);
						return;
					}

					case "reset-rounds": {
						const gate = rest[0];
						if (!gate) {
							ctx.ui.notify("Usage: /apnea reset-rounds <gate>", "error");
							return;
						}
						notify(ctx, workflowResetRounds({ gate }));
						return;
					}

					default:
						ctx.ui.notify(`Unknown subcommand: ${sub}\n${helpText()}`, "error");
				}
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});

	// Short aliases that also show in `/` autocomplete
	pi.registerCommand("apnea-status", {
		description: "Apnea: read-only run status (alias of /apnea status)",
		handler: async (_args, ctx) => notify(ctx, workflowStatus()),
	});

	pi.registerCommand("apnea-start", {
		description: "Apnea: start a run — /apnea-start <goal>",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /apnea-start <goal>", "error");
				return;
			}
			const r = workflowStart({ goal, action: "start" });
			notify(ctx, r);
			if (r.ok) kick("start", goal);
		},
	});
}
