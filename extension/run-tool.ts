import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { isAppError, toToolResult } from "./errors.ts";
import type { ToolResult } from "./result.ts";

/**
 * Per-call runner (no toolContent wrap): provide `layer`, map AppError →
 * ToolResult, defects → bug:. No module-level ManagedRuntime.
 */
export async function runToolResult<E, R>(
	effect: Effect.Effect<ToolResult, E, R>,
	// Required: a defaulted `Layer.empty as Layer.Layer<R>` erases R, so calling
	// without the layer would type-check and then die as a service-not-found
	// defect on every invocation. Pass `Layer.empty` explicitly when R is never.
	layer: Layer.Layer<R, never, never>,
): Promise<ToolResult> {
	const provided = Effect.provide(effect, layer) as Effect.Effect<
		ToolResult,
		E
	>;
	const exit = await Effect.runPromiseExit(provided);

	if (Exit.isSuccess(exit)) {
		return exit.value;
	}

	const error = Exit.findErrorOption(exit);
	if (Option.isSome(error) && isAppError(error.value)) {
		return toToolResult(error.value);
	}

	const defect = Cause.findDefect(exit.cause);
	const msg = Result.isSuccess(defect)
		? defectMessage(defect.success)
		: defectMessage(Cause.squash(exit.cause));
	return { ok: false, error: `bug: ${msg}` };
}

function defectMessage(defect: unknown): string {
	if (defect instanceof Error) return defect.message || defect.name;
	if (typeof defect === "string") return defect;
	try {
		return JSON.stringify(defect);
	} catch {
		return String(defect);
	}
}
