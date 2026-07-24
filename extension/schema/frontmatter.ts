import { Result, Schema } from "effect";
import { ArtifactInvalid } from "../errors.ts";

const VerdictSchema = Schema.Literals(["APPROVED", "CHANGES_REQUIRED"] as const);

/**
 * Schema for the parsed front-matter result shape (after the line parser).
 * Consumed by wait in Phase 4.
 */
export const FrontMatterResultSchema = Schema.Struct({
	status: Schema.String,
	verdict: Schema.optional(VerdictSchema),
	nits: Schema.optional(Schema.String),
});

export type FrontMatterResult = typeof FrontMatterResultSchema.Type;

export function decodeFrontMatterResult(
	raw: unknown,
	artifact = "artifact",
): Result.Result<FrontMatterResult, ArtifactInvalid> {
	const decoded = Schema.decodeUnknownResult(FrontMatterResultSchema)(raw);
	if (Result.isFailure(decoded)) {
		return Result.fail(
			new ArtifactInvalid({
				artifact,
				message: decoded.failure.message,
			}),
		);
	}
	return Result.succeed(decoded.success);
}
