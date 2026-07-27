import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { globalConfigPath } from "./paths.ts";

describe("globalConfigPath", () => {
	test("follows HOME when set", () => {
		const prev = process.env.HOME;
		process.env.HOME = "/tmp/apnea-home";
		try {
			expect(globalConfigPath()).toBe(
				path.join("/tmp/apnea-home", ".config", "apnea", "config.json"),
			);
		} finally {
			if (prev === undefined) delete process.env.HOME;
			else process.env.HOME = prev;
		}
	});

	// An env-only lookup returns "" without HOME (launchd/systemd/`env -i`),
	// making this path cwd-relative — i.e. the *project repo* would be read as
	// the trusted global config, the one place profiles/cmd_interactive are
	// honoured. A cloned repo could then spawn its own cmd_interactive.
	test("stays absolute when HOME and USERPROFILE are both unset", () => {
		const home = process.env.HOME;
		const userProfile = process.env.USERPROFILE;
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		try {
			const p = globalConfigPath();
			expect(path.isAbsolute(p)).toBe(true);
			expect(p.startsWith(path.join(process.cwd(), ".config"))).toBe(false);
		} finally {
			if (home !== undefined) process.env.HOME = home;
			if (userProfile !== undefined) process.env.USERPROFILE = userProfile;
		}
	});
});
