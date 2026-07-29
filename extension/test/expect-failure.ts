import { expect } from "bun:test";
import { Result } from "effect";

/**
 * Assert a Result failed with a specific tag, then hand back the narrowed
 * failure for field assertions.
 *
 * The point is the two unconditional `expect`s: the previous
 * `if (r._tag === "Failure" && r.failure._tag === "X")` idiom silently skipped
 * its body when the code produced the *wrong* failure, so those tests could
 * not fail.
 *
 * The two `throw`s below each `expect` are TypeScript narrowing aids only —
 * in practice they are unreachable, because bun's `expect(...).toBe(...)`
 * throws first on a mismatch.
 */
export function expectFailure<A, E extends { _tag: string }, T extends E["_tag"]>(
	r: Result.Result<A, E>,
	tag: T,
): Extract<E, { _tag: T }> {
	expect(Result.isFailure(r)).toBe(true);
	if (!Result.isFailure(r)) {
		throw new Error("expected Failure, got Success");
	}
	expect(r.failure._tag).toBe(tag);
	if (r.failure._tag !== tag) {
		throw new Error(`expected failure ${tag}, got ${r.failure._tag}`);
	}
	return r.failure as Extract<E, { _tag: T }>;
}
