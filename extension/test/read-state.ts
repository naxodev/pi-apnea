import { Effect } from "effect";
import type { RunState } from "../domain/types.ts";
import { AppLive } from "../services/app-live.ts";
import { RunStore } from "../services/run-store.ts";

/** Read state.json through the real RunStore (decode included); defects on failure. */
export function readState(root: string): Promise<RunState> {
	return Effect.runPromise(
		Effect.provide(
			Effect.gen(function* () {
				const store = yield* RunStore;
				return yield* store.require(root);
			}).pipe(Effect.orDie),
			AppLive,
		),
	);
}
