import { Schema } from "effect";
import { err, type ToolErr } from "./result.ts";

/** No `.apnea/state.json` for the current project root. */
export class NoRunState extends Schema.TaggedErrorClass<NoRunState>()(
	"NoRunState",
	{},
) {}

/** Tool call refused by the step → legal-tools table. */
export class IllegalTool extends Schema.TaggedErrorClass<IllegalTool>()(
	"IllegalTool",
	{
		step: Schema.String,
		tool: Schema.String,
		legal: Schema.Array(Schema.String),
	},
) {}

/** Dispatch kind refused at the current step. */
export class IllegalKind extends Schema.TaggedErrorClass<IllegalKind>()(
	"IllegalKind",
	{
		step: Schema.String,
		kind: Schema.String,
		allowed: Schema.Array(Schema.String),
	},
) {}

/** Global or project config missing, invalid, or untrusted. */
export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()(
	"ConfigError",
	{
		message: Schema.String,
		path: Schema.optional(Schema.String),
	},
) {}

/** `state.json` present but not decodable / inconsistent. */
export class StateCorrupt extends Schema.TaggedErrorClass<StateCorrupt>()(
	"StateCorrupt",
	{
		path: Schema.String,
		message: Schema.String,
	},
) {}

/** VCS detect / dirty / commit / bookmark failure. */
export class VcsError extends Schema.TaggedErrorClass<VcsError>()("VcsError", {
	message: Schema.String,
	command: Schema.optional(Schema.String),
}) {}

/** Herdr CLI / pane / floating failure. */
export class HerdrError extends Schema.TaggedErrorClass<HerdrError>()(
	"HerdrError",
	{
		message: Schema.String,
		command: Schema.optional(Schema.String),
		details: Schema.optional(
			Schema.Record(Schema.String, Schema.Unknown),
		),
	},
) {}

/** Commit/review gate refused (e.g. verdict not APPROVED). */
export class GateRefused extends Schema.TaggedErrorClass<GateRefused>()(
	"GateRefused",
	{
		gate: Schema.String,
		message: Schema.String,
		details: Schema.optional(
			Schema.Record(Schema.String, Schema.Unknown),
		),
	},
) {}

/** `workflow_wait` hit its timeout without a complete artifact. */
export class WaitTimeout extends Schema.TaggedErrorClass<WaitTimeout>()(
	"WaitTimeout",
	{
		artifact: Schema.String,
		timeoutMs: Schema.Number,
		details: Schema.optional(
			Schema.Record(Schema.String, Schema.Unknown),
		),
	},
) {}

/** `workflow_wait` aborted (Esc / cancel signal). */
export class WaitAborted extends Schema.TaggedErrorClass<WaitAborted>()(
	"WaitAborted",
	{
		artifact: Schema.String,
		details: Schema.optional(
			Schema.Record(Schema.String, Schema.Unknown),
		),
	},
) {}

/** Artifact exists but front-matter / shape is invalid. */
export class ArtifactInvalid extends Schema.TaggedErrorClass<ArtifactInvalid>()(
	"ArtifactInvalid",
	{
		artifact: Schema.String,
		message: Schema.String,
	},
) {}

/** Phase-package verify commands failed — commit refused. */
export class VerifyFailed extends Schema.TaggedErrorClass<VerifyFailed>()(
	"VerifyFailed",
	{
		commands: Schema.Array(Schema.String),
		outputs: Schema.Array(Schema.String),
	},
) {}

export type AppError =
	| NoRunState
	| IllegalTool
	| IllegalKind
	| ConfigError
	| StateCorrupt
	| VcsError
	| HerdrError
	| GateRefused
	| WaitTimeout
	| WaitAborted
	| ArtifactInvalid
	| VerifyFailed;

const APP_ERROR_TAGS = new Set<string>([
	"NoRunState",
	"IllegalTool",
	"IllegalKind",
	"ConfigError",
	"StateCorrupt",
	"VcsError",
	"HerdrError",
	"GateRefused",
	"WaitTimeout",
	"WaitAborted",
	"ArtifactInvalid",
	"VerifyFailed",
]);

export function isAppError(u: unknown): u is AppError {
	return (
		typeof u === "object" &&
		u !== null &&
		"_tag" in u &&
		typeof (u as { _tag: unknown })._tag === "string" &&
		APP_ERROR_TAGS.has((u as { _tag: string })._tag)
	);
}

/** Map a tagged app error to the stable ToolErr boundary shape. */
export function toToolResult(e: AppError): ToolErr {
	switch (e._tag) {
		case "NoRunState":
			return err("no run state; call workflow_start first", {
				legal_next: ["workflow_start"],
			});
		case "IllegalTool":
			return err(
				`illegal tool ${e.tool} at step=${e.step}. legal: ${e.legal.join(", ") || "(none)"}`,
				{
					legal_next: [...e.legal],
					data: { step: e.step, tool: e.tool },
				},
			);
		case "IllegalKind":
			return err(
				`kind=${e.kind} not allowed at step=${e.step}. allowed: ${e.allowed.join(", ")}`,
				{
					legal_next: [
						"dispatch_role with allowed kind",
						"workflow_status",
					],
					data: { step: e.step, kind: e.kind, allowed: e.allowed },
				},
			);
		case "ConfigError":
			return err(e.message, {
				data: e.path !== undefined ? { path: e.path } : undefined,
			});
		case "StateCorrupt":
			return err(`corrupt state at ${e.path}: ${e.message}`, {
				data: { path: e.path },
			});
		case "VcsError":
			return err(e.message, {
				data: e.command !== undefined ? { command: e.command } : undefined,
			});
		case "HerdrError":
			return err(e.message, {
				data:
					e.command !== undefined || e.details !== undefined
						? {
								...(e.command !== undefined ? { command: e.command } : {}),
								...(e.details ?? {}),
							}
						: undefined,
			});
		case "GateRefused":
			return err(e.message, {
				data: {
					gate: e.gate,
					...(e.details ?? {}),
				},
			});
		case "WaitTimeout":
			return err(
				`timeout after ${e.timeoutMs}ms waiting for ${e.artifact}`,
				{
					data: {
						artifact: e.artifact,
						timeout_ms: e.timeoutMs,
						...(e.details ?? {}),
					},
				},
			);
		case "WaitAborted":
			return err("workflow_wait aborted (Esc / cancel)", {
				data: { artifact: e.artifact, ...(e.details ?? {}) },
			});
		case "ArtifactInvalid":
			return err(e.message, { data: { artifact: e.artifact } });
		case "VerifyFailed":
			return err("verify commands failed — commit refused", {
				data: { commands: e.commands, outputs: e.outputs },
			});
	}
}
