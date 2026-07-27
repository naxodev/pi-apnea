import { Result } from "effect";
import { ArtifactInvalid } from "../errors.ts";
import type { DispatchKind } from "./state-machine.ts";

/** Infer the dispatch kind an artifact path corresponds to. Ordering matters:
 * plan-review must be checked before the bare plan.md suffix check. */
export function inferKind(
	artifactRel: string,
): Result.Result<DispatchKind, ArtifactInvalid> {
	if (artifactRel.endsWith("plan.md") && !artifactRel.includes("plan-review"))
		return Result.succeed("plan");
	if (artifactRel.includes("plan-review")) return Result.succeed("plan_review");
	if (artifactRel.endsWith("phase-package.md"))
		return Result.succeed("phase_package");
	if (artifactRel.endsWith("coder-result.md")) return Result.succeed("code");
	if (artifactRel.endsWith("code-review.md"))
		return Result.succeed("code_review");
	if (artifactRel.endsWith("pr-description.md"))
		return Result.succeed("pr_description");
	return Result.fail(
		new ArtifactInvalid({
			artifact: artifactRel,
			message: `cannot infer dispatch kind from ${artifactRel}`,
		}),
	);
}
