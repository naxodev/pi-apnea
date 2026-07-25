import { Cause, Effect, Exit, Layer, Option, Result } from "effect";
import { isAppError, toToolResult } from "./errors.ts";
import { toolContent, type ToolResult } from "./result.ts";

export type ToolContent = ReturnType<typeof toolContent>;

/**
 * Per-call runner (no toolContent wrap): provide `layer`, map AppError →
 * ToolResult, defects → bug:. No module-level ManagedRuntime.
 */
export async function runToolResult<E, R>(
	effect: Effect.Effect<ToolResult, E, R>,
	layer: Layer.Layer<R, never, never> = Layer.empty as Layer.Layer<
		R,
		never,
		never
	>,
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

/**
 * Per-call runner: provide `layer`, map AppError → ToolResult, defects → bug:.
 * No module-level ManagedRuntime — fresh provide each call.
 */
export async function runTool<E, R>(
	effect: Effect.Effect<ToolResult, E, R>,
	layer: Layer.Layer<R, never, never> = Layer.empty as Layer.Layer<
		R,
		never,
		never
	>,
): Promise<ToolContent> {
	return toolContent(await runToolResult(effect, layer));
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
