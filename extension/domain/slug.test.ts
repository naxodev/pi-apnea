import { describe, expect, test } from "bun:test";
import { slugify } from "./slug.ts";

describe("slugify", () => {
	test("normalizes and trims", () => {
		expect(slugify("Hello, World!")).toBe("hello-world");
		expect(slugify("  ---  ")).toBe("run");
		expect(slugify("a".repeat(60)).length).toBe(48);
	});
});
