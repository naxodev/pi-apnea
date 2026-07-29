/**
 * User-facing slash commands with `/` autocomplete.
 * These call the same functions as the LLM tools — no workflow_* typing required.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatResult } from "../result.ts";
import { apneaSetup } from "./setup.ts";
import { DISPATCH_KINDS } from "../domain/state-machine.ts";
import type { DispatchKind } from "../domain/state-machine.ts";
import type { ToolResult } from "../result.ts";
import { workflowStart } from "./start.ts";
import { workflowResetRounds, workflowStatus } from "./status.ts";
import { workflowCommitPhase } from "./commit.ts";
import { workflowDispatch } from "./dispatch.ts";
import { workflowWait } from "./wait.ts";

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

/**
 * Split `--bare` switches from `--key=value` options; everything else is
 * positional. `values` matters: `rest` never sees a `--`-prefixed token, so
 * `--key=value` options are only reachable through the map.
 */
export function parseFlags(tokens: string[]): {
	flags: Set<string>;
	values: Map<string, string>;
	rest: string[];
} {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const rest: string[] = [];
	for (const t of tokens) {
		if (!t.startsWith("--")) {
			rest.push(t);
			continue;
		}
		const body = t.slice(2);
		const eq = body.indexOf("=");
		if (eq > 0) values.set(body.slice(0, eq), body.slice(eq + 1));
		else flags.add(body);
	}
	return { flags, values, rest };
}

function helpText(): string {
	return [
		"Apnea commands (tools remain for the model; you use /apnea):",
		"  /apnea setup [--project] [--force]   # global profiles; optional project bindings",
		"  /apnea start <goal> [--allow-dirty] [--slug=name]",
		"  /apnea resume | abandon | status",
		"  /apnea wait [--timeout=<ms>]",
		"  /apnea dispatch <kind> [--rework]",
		`      kinds: ${DISPATCH_KINDS.join(" | ")}`,
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
				// Complete the kind token only — Pi replaces the last token.
				const hits = DISPATCH_KINDS.filter((k) => k.startsWith(p)).map((k) => ({
					value: k,
					label: k,
				}));
				return hits.length ? hits : null;
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
			const { flags, values, rest } = parseFlags(tokens.slice(1));

			try {
				switch (sub) {
					case "help":
						ctx.ui.notify(helpText(), "info");
						return;

					case "setup":
						notify(
							ctx,
							await apneaSetup({
								project: flags.has("project"),
								force: flags.has("force"),
							}),
						);
						return;

					case "start": {
						// goal is everything not a flag; support --slug=x
						const slug = values.get("slug");
						const goal = rest.join(" ").trim();
						if (!goal) {
							ctx.ui.notify(
								"Usage: /apnea start <goal> [--allow-dirty] [--slug=name]",
								"error",
							);
							return;
						}
						const r = await workflowStart({
							goal,
							slug,
							allow_dirty: flags.has("allow-dirty"),
							action: "start",
						});
						notify(ctx, r);
						if (r.ok) kick("start", goal);
						return;
					}

					case "resume": {
						const r = await workflowStart({ goal: "", action: "resume" });
						notify(ctx, r);
						if (r.ok) kick("resume");
						return;
					}

					case "abandon":
						notify(
							ctx,
							await workflowStart({ goal: "", action: "abandon" }),
						);
						return;

					case "status":
						notify(ctx, await workflowStatus());
						return;

					case "wait": {
						const timeoutTok = values.get("timeout");
						const parsed = timeoutTok ? Number(timeoutTok) : undefined;
						if (parsed !== undefined && !Number.isFinite(parsed)) {
							ctx.ui.notify(
								`Usage: /apnea wait [--timeout=<ms>] (got --timeout=${timeoutTok})`,
								"error",
							);
							return;
						}
						const r = await workflowWait({ budget_ms: parsed });
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
							await workflowDispatch({
								kind,
								rework: flags.has("rework"),
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
							await workflowCommitPhase({
								message,
								no_remaining_phases: flags.has("done"),
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
						notify(ctx, await workflowResetRounds({ gate }));
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
		handler: async (_args, ctx) => notify(ctx, await workflowStatus()),
	});

	pi.registerCommand("apnea-start", {
		description: "Apnea: start a run — /apnea-start <goal>",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /apnea-start <goal>", "error");
				return;
			}
			const r = await workflowStart({ goal, action: "start" });
			notify(ctx, r);
			if (r.ok) kick("start", goal);
		},
	});
}
