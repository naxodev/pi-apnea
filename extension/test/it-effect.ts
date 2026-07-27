import { test } from "bun:test";
import { Effect, type Layer } from "effect";

/**
 * Thin bun:test helper that runs an Effect with Effect.runPromise.
 * Optional layer (defaults to Layer.empty).
 */
export function itEffect<A, E, R = never>(
	name: string,
	body: () => Effect.Effect<A, E, R>,
	layer?: Layer.Layer<R, never, never>,
): void {
	test(name, async () => {
		const effect = body();
		const provided = layer
			? (Effect.provide(effect, layer) as Effect.Effect<A, E>)
			: (effect as Effect.Effect<A, E>);
		await Effect.runPromise(provided);
	});
}
