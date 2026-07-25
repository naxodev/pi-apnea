import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeFakeFileSystem } from "../test/fake-file-system.ts";
import { itEffect } from "../test/it-effect.ts";
import { Vcs, VcsLive, filterAppPaths } from "./vcs.ts";

function withFake(initial: Record<string, string> = {}) {
	const fake = makeFakeFileSystem(initial);
	// Also mark directories that exist as empty keys via mkdir semantics —
	// exists returns true for dirs. Seed .jj/.git as empty file markers.
	const layer = Layer.provideMerge(VcsLive, fake.layer);
	return { fake, layer };
}

describe("Vcs.detect (fake FileSystem)", () => {
	itEffect(".jj → jj", () => {
		const { layer } = withFake({ "/proj/.jj": "" });
		return Effect.gen(function* () {
			const vcs = yield* Vcs;
			expect(yield* vcs.detect("/proj")).toBe("jj");
		}).pipe(Effect.provide(layer));
	});

	itEffect(".git → git", () => {
		const { layer } = withFake({ "/proj/.git": "" });
		return Effect.gen(function* () {
			const vcs = yield* Vcs;
			expect(yield* vcs.detect("/proj")).toBe("git");
		}).pipe(Effect.provide(layer));
	});

	itEffect("neither → null", () => {
		const { layer } = withFake();
		return Effect.gen(function* () {
			const vcs = yield* Vcs;
			expect(yield* vcs.detect("/proj")).toBeNull();
		}).pipe(Effect.provide(layer));
	});

	itEffect(".jj wins over .git", () => {
		const { layer } = withFake({
			"/proj/.jj": "",
			"/proj/.git": "",
		});
		return Effect.gen(function* () {
			const vcs = yield* Vcs;
			expect(yield* vcs.detect("/proj")).toBe("jj");
		}).pipe(Effect.provide(layer));
	});
});

describe("filterAppPaths", () => {
	test("drops git porcelain .apnea/ lines; keeps src", () => {
		const input = [
			" M .apnea/state.json",
			" M src/x.ts",
			' M ".apnea/artifacts/x"',
			"",
		].join("\n");
		const out = filterAppPaths(input);
		expect(out).toBe(" M src/x.ts");
	});

	test("drops jj summary .apnea/ lines", () => {
		const input = ["M .apnea/state.json", "M src/y.ts", "A foo.ts"].join("\n");
		const out = filterAppPaths(input);
		expect(out.split("\n")).toEqual(["M src/y.ts", "A foo.ts"]);
	});

	test("drops blank lines", () => {
		expect(filterAppPaths("\n\n  \n")).toBe("");
	});
});
