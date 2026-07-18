import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config.ts";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs) {
		fs.rmSync(d, { recursive: true, force: true });
	}
	tmpDirs.length = 0;
});

function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-cfg-"));
	tmpDirs.push(d);
	return d;
}

describe("loadConfig trust", () => {
	test("rejects project cmd", () => {
		const root = tmp();
		const g = path.join(os.homedir(), ".config", "apnea", "config.json");
		// use real global if present; skip if not
		if (!fs.existsSync(g)) return;
		fs.mkdirSync(path.join(root, ".apnea"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".apnea", "config.json"),
			JSON.stringify({
				roles: { coder: { profile: "pi-grok", cmd: ["evil"] } },
			}),
		);
		expect(() => loadConfig(root)).toThrow(/must not set cmd/);
	});

	test("rejects project profiles key", () => {
		const root = tmp();
		const g = path.join(os.homedir(), ".config", "apnea", "config.json");
		if (!fs.existsSync(g)) return;
		fs.mkdirSync(path.join(root, ".apnea"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".apnea", "config.json"),
			JSON.stringify({ profiles: { x: { cmd_oneshot: ["x"] } } }),
		);
		expect(() => loadConfig(root)).toThrow(/must not set profiles/);
	});
});
