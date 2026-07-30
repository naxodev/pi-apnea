#!/usr/bin/env bun
import { parseFlags, parseNumFlag } from "./parse.ts";
import { EXIT_ERROR, EXIT_USAGE, exitCodeFor, renderHuman, renderJson } from "./format.ts";
import { confirmHuman, prodHumanGateDeps } from "./human-gate.ts";
import { OPERATIONS, findByVerb } from "../registry.ts";
import { DISPATCH_KINDS } from "../domain/state-machine.ts";
import type { ToolResult } from "../result.ts";

function usage(): string {
	return [
		"apnea — multi-role workflow driver",
		"",
		"Usage: apnea <command> [args] [--json]",
		"",
		...OPERATIONS.map(
			(o) => `  ${`${o.verb} ${o.usage ?? ""}`.trim().padEnd(38)} ${o.summary}`,
		),
		"  resume | abandon   actions on an existing run",
		"",
		`dispatch kinds: ${DISPATCH_KINDS.join(" | ")}`,
		"",
		"Exit codes: 0 ok · 1 refused/error · 2 usage · 3 still waiting (call again)",
	].join("\n");
}

/**
 * Renders a usage failure through the same `renderJson`/`renderHuman` split
 * as every other exit path, so a `--json` caller gets parseable output on
 * exit 2 too instead of a plain-text message that breaks its parser. The
 * full command listing is only useful to a human reading a terminal, so it's
 * appended after the rendered error and only outside `--json` mode.
 */
function printUsageError(message: string, json: boolean): void {
	const result: ToolResult = { ok: false, error: message };
	console.error(json ? renderJson(result) : `${renderHuman(result)}\n\n${usage()}`);
}

export async function main(argv: string[]): Promise<number> {
	const [verbRaw, ...rest] = argv;
	const { flags, values, rest: positional } = parseFlags(rest);
	const json = flags.has("json");

	if (!verbRaw) {
		printUsageError("usage: apnea <command> [args] [--json]", json);
		return EXIT_USAGE;
	}
	if (verbRaw === "help" || verbRaw === "--help") {
		console.log(usage());
		return 0;
	}

	// `resume` and `abandon` are actions on the start operation.
	const isAction = verbRaw === "resume" || verbRaw === "abandon";
	const op = findByVerb(isAction ? "start" : verbRaw);
	if (!op) {
		printUsageError(`unknown command: ${verbRaw}`, json);
		return EXIT_USAGE;
	}

	const built = buildParams(op.verb, isAction ? verbRaw : null, flags, values, positional);
	if (!built.ok) {
		printUsageError(
			built.message ?? `usage: apnea ${op.verb} ${op.usage}`.trim(),
			json,
		);
		return EXIT_USAGE;
	}

	if (op.humanOnly) {
		const gate = String(built.params.gate ?? "");
		const confirmed = await confirmHuman(gate, prodHumanGateDeps, flags.has("i-am-human"));
		if (!confirmed.ok) {
			console.error(`ERROR: ${confirmed.reason}`);
			return EXIT_ERROR;
		}
	}

	const result = await op.run(built.params);
	const text = json ? renderJson(result) : renderHuman(result);
	if (result.ok) console.log(text);
	else console.error(text);
	return exitCodeFor(result);
}

export type BuildParamsResult =
	| { ok: true; params: Record<string, unknown> }
	| { ok: false; message?: string };

export function buildParams(
	verb: string,
	action: string | null,
	flags: Set<string>,
	values: Map<string, string>,
	positional: string[],
): BuildParamsResult {
	switch (verb) {
		case "start": {
			if (action) return { ok: true, params: { action } };
			const goal = positional.join(" ").trim();
			if (!goal) {
				return {
					ok: false,
					message: "usage: apnea start <goal> [--allow-dirty] [--slug=name]",
				};
			}
			return {
				ok: true,
				params: {
					action: "start",
					goal,
					slug: values.get("slug"),
					allow_dirty: flags.has("allow-dirty") || undefined,
				},
			};
		}
		case "dispatch": {
			const kind = positional[0];
			if (!kind || !DISPATCH_KINDS.includes(kind as never)) {
				return {
					ok: false,
					message: `usage: apnea dispatch <${DISPATCH_KINDS.join("|")}> [--rework]`,
				};
			}
			return { ok: true, params: { kind, rework: flags.has("rework") || undefined } };
		}
		case "wait": {
			// `--timeout` and `--budget` are the same knob: how long THIS call
			// blocks. The role's deadline comes from config, stamped at dispatch.
			const poll = parseNumFlag(values, "poll");
			if (!poll.ok) {
				return {
					ok: false,
					message: `usage: apnea wait [--poll=<ms>] (got --poll=${poll.raw})`,
				};
			}
			const budget = parseNumFlag(values, "budget");
			if (!budget.ok) {
				return {
					ok: false,
					message: `usage: apnea wait [--budget=<ms>] (got --budget=${budget.raw})`,
				};
			}
			const timeout = parseNumFlag(values, "timeout");
			if (!timeout.ok) {
				return {
					ok: false,
					message: `usage: apnea wait [--timeout=<ms>] (got --timeout=${timeout.raw})`,
				};
			}
			return {
				ok: true,
				params: { poll_ms: poll.value, budget_ms: budget.value ?? timeout.value },
			};
		}
		case "commit": {
			const message = positional.join(" ").trim();
			return {
				ok: true,
				params: {
					message: message || undefined,
					no_remaining_phases: flags.has("done") || undefined,
				},
			};
		}
		case "status":
			return { ok: true, params: {} };
		case "reset-rounds": {
			const gate = positional[0];
			if (!gate) {
				return { ok: false, message: "usage: apnea reset-rounds <gate>" };
			}
			return { ok: true, params: { gate } };
		}
		case "setup":
			return {
				ok: true,
				params: {
					project: flags.has("project") || undefined,
					force: flags.has("force") || undefined,
					agents_md: flags.has("agents-md") || undefined,
				},
			};
		default:
			return { ok: false };
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
