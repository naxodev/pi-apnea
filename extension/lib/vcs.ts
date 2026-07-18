import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { VcsBackend } from "./types.ts";

function run(
	cmd: string,
	args: string[],
	cwd: string,
): { ok: boolean; stdout: string; stderr: string; code: number } {
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});
	return {
		ok: r.status === 0,
		stdout: (r.stdout ?? "").toString(),
		stderr: (r.stderr ?? "").toString(),
		code: r.status ?? 1,
	};
}

export function detectVcs(root: string): VcsBackend | null {
	if (fs.existsSync(path.join(root, ".jj"))) return "jj";
	if (fs.existsSync(path.join(root, ".git"))) return "git";
	return null;
}

/** Drop .apnea/ runtime paths from VCS summaries (artifacts are allowed). */
function filterAppPaths(summary: string): string {
	return summary
		.split(/\r?\n/)
		.filter((line) => {
			const t = line.trim();
			if (!t) return false;
			// git porcelain: XY path
			if (/^.. /.test(line)) {
				const p = line.slice(3).replace(/^"|"$/g, "");
				return !p.startsWith(".apnea/") && !p.includes("/.apnea/");
			}
			// jj summary often: M path / A path
			const m = t.match(/^[A-Z]+\s+(.+)$/);
			if (m) {
				const p = m[1]!;
				return !p.startsWith(".apnea/") && !p.includes("/.apnea/");
			}
			return !t.includes(".apnea/");
		})
		.join("\n");
}

/** File-content dirty check (not op-log). Ignores .apnea/ runtime. */
export function isDirty(root: string, vcs: VcsBackend): boolean {
	return treeFingerprint(root, vcs).trim().length > 0;
}

export function treeFingerprint(root: string, vcs: VcsBackend): string {
	if (vcs === "jj") {
		const r = run("jj", ["diff", "--summary"], root);
		return filterAppPaths(r.stdout);
	}
	const r = run("git", ["status", "--porcelain"], root);
	return filterAppPaths(r.stdout);
}

export function ensureGitBranch(root: string, slug: string): string {
	const branch = `apnea/${slug}`;
	const cur = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
	if (cur.stdout.trim() === branch) return branch;
	const exists = run(
		"git",
		["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
		root,
	);
	if (exists.ok) {
		const co = run("git", ["checkout", branch], root);
		if (!co.ok) throw new Error(`git checkout ${branch}: ${co.stderr}`);
		return branch;
	}
	const cr = run("git", ["checkout", "-b", branch], root);
	if (!cr.ok) throw new Error(`git checkout -b ${branch}: ${cr.stderr}`);
	return branch;
}

export function commitPhase(
	root: string,
	vcs: VcsBackend,
	message: string,
): { ok: boolean; detail: string } {
	if (vcs === "jj") {
		const d = run("jj", ["describe", "-m", message], root);
		if (!d.ok) return { ok: false, detail: d.stderr || d.stdout };
		const n = run("jj", ["new"], root);
		if (!n.ok) return { ok: false, detail: n.stderr || n.stdout };
		return { ok: true, detail: "jj describe + new" };
	}
	const add = run("git", ["add", "-A"], root);
	if (!add.ok) return { ok: false, detail: add.stderr };
	const c = run("git", ["commit", "-m", message], root);
	if (!c.ok) return { ok: false, detail: c.stderr || c.stdout };
	return { ok: true, detail: "git commit" };
}

export function setJjBookmarkAtTerminus(root: string, slug: string): void {
	const name = `apnea/${slug}`;
	// Point at parent of working copy (last described change)
	const r = run("jj", ["bookmark", "set", name, "-r", "@-"], root);
	if (!r.ok) {
		// older jj: branch
		run("jj", ["bookmark", "create", name, "-r", "@-"], root);
	}
}

export function runVerifyCommands(
	root: string,
	commands: string[],
	timeoutMs: number,
): { ok: boolean; log: string } {
	const lines: string[] = [];
	for (const cmd of commands) {
		lines.push(`$ ${cmd}`);
		const r = spawnSync("bash", ["-lc", cmd], {
			cwd: root,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 10 * 1024 * 1024,
		});
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd();
		if (out) lines.push(out);
		lines.push(`exit=${r.status ?? 1}`);
		if (r.error) {
			lines.push(String(r.error));
			return { ok: false, log: lines.join("\n") };
		}
		if (r.status !== 0) {
			return { ok: false, log: lines.join("\n") };
		}
		lines.push("");
	}
	return { ok: true, log: lines.join("\n") };
}

/** Extract shell commands from a fenced ```sh block in phase package, or lines under **Verify commands**. */
export function extractVerifyCommands(phasePackageText: string): string[] {
	const cmds: string[] = [];
	const fence = phasePackageText.match(
		/```(?:sh|bash|shell)\r?\n([\s\S]*?)```/i,
	);
	if (fence) {
		for (const line of fence[1]!.split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			cmds.push(t);
		}
		if (cmds.length) return cmds;
	}
	// fallback: consecutive indented $ lines
	for (const line of phasePackageText.split(/\r?\n/)) {
		const m = line.match(/^\s*(?:\$\s+)?(test |node |npm |chmod |head ).+$/);
		if (m) cmds.push(line.replace(/^\s*\$\s*/, "").trim());
	}
	return cmds;
}
