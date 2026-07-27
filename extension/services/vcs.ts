import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { VcsError } from "../errors.ts";
import type { VcsBackend } from "../domain/types.ts";
import { FileSystem } from "./file-system.ts";

export interface VcsService {
	readonly detect: (root: string) => Effect.Effect<VcsBackend | null>;
	readonly isDirty: (root: string, vcs: VcsBackend) => Effect.Effect<boolean>;
	readonly treeFingerprint: (
		root: string,
		vcs: VcsBackend,
	) => Effect.Effect<string>;
	readonly ensureGitBranch: (
		root: string,
		slug: string,
	) => Effect.Effect<string, VcsError>;
	readonly commitPhase: (
		root: string,
		vcs: VcsBackend,
		message: string,
	) => Effect.Effect<string, VcsError>;
	readonly setBookmarkAtTerminus: (
		root: string,
		slug: string,
	) => Effect.Effect<void>;
	readonly runVerify: (
		root: string,
		commands: readonly string[],
		timeoutMs: number,
	) => Effect.Effect<{ ok: boolean; log: string }>;
}

export class Vcs extends Context.Service<Vcs, VcsService>()("apnea/Vcs") {}

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

/** Drop .apnea/ runtime paths from VCS summaries (artifacts are allowed). */
export function filterAppPaths(summary: string): string {
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

export const VcsLive = Layer.effect(
	Vcs,
	Effect.gen(function* () {
		const fs = yield* FileSystem;

		const detect = (root: string): Effect.Effect<VcsBackend | null> =>
			Effect.gen(function* () {
				if (yield* fs.exists(path.join(root, ".jj"))) return "jj";
				if (yield* fs.exists(path.join(root, ".git"))) return "git";
				return null;
			});

		const treeFingerprint = (
			root: string,
			vcs: VcsBackend,
		): Effect.Effect<string> =>
			Effect.sync(() => {
				if (vcs === "jj") {
					const r = run("jj", ["diff", "--summary"], root);
					return filterAppPaths(r.stdout);
				}
				const r = run("git", ["status", "--porcelain"], root);
				return filterAppPaths(r.stdout);
			});

		const isDirty = (
			root: string,
			vcs: VcsBackend,
		): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const fp = yield* treeFingerprint(root, vcs);
				return fp.trim().length > 0;
			});

		const ensureGitBranch = (
			root: string,
			slug: string,
		): Effect.Effect<string, VcsError> =>
			Effect.gen(function* () {
				const branch = `apnea/${slug}`;
				const cur = yield* Effect.sync(() =>
					run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root),
				);
				if (cur.stdout.trim() === branch) return branch;
				const exists = yield* Effect.sync(() =>
					run(
						"git",
						["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
						root,
					),
				);
				if (exists.ok) {
					const co = yield* Effect.sync(() =>
						run("git", ["checkout", branch], root),
					);
					if (!co.ok) {
						return yield* new VcsError({
							message: `git checkout ${branch}: ${co.stderr}`,
							command: `git checkout ${branch}`,
						});
					}
					return branch;
				}
				const cr = yield* Effect.sync(() =>
					run("git", ["checkout", "-b", branch], root),
				);
				if (!cr.ok) {
					return yield* new VcsError({
						message: `git checkout -b ${branch}: ${cr.stderr}`,
						command: `git checkout -b ${branch}`,
					});
				}
				return branch;
			});

		const commitPhase = (
			root: string,
			vcs: VcsBackend,
			message: string,
		): Effect.Effect<string, VcsError> =>
			Effect.gen(function* () {
				if (vcs === "jj") {
					const d = yield* Effect.sync(() =>
						run("jj", ["describe", "-m", message], root),
					);
					if (!d.ok) {
						return yield* new VcsError({
							message: d.stderr || d.stdout,
							command: "jj describe",
						});
					}
					const n = yield* Effect.sync(() => run("jj", ["new"], root));
					if (!n.ok) {
						return yield* new VcsError({
							message: n.stderr || n.stdout,
							command: "jj new",
						});
					}
					return "jj describe + new";
				}
				const add = yield* Effect.sync(() =>
					run("git", ["add", "-A"], root),
				);
				if (!add.ok) {
					return yield* new VcsError({
						message: add.stderr,
						command: "git add -A",
					});
				}
				const c = yield* Effect.sync(() =>
					run("git", ["commit", "-m", message], root),
				);
				if (!c.ok) {
					return yield* new VcsError({
						message: c.stderr || c.stdout,
						command: "git commit",
					});
				}
				return "git commit";
			});

		const setBookmarkAtTerminus = (
			root: string,
			slug: string,
		): Effect.Effect<void> =>
			Effect.sync(() => {
				const name = `apnea/${slug}`;
				const r = run("jj", ["bookmark", "set", name, "-r", "@-"], root);
				if (!r.ok) {
					run("jj", ["bookmark", "create", name, "-r", "@-"], root);
				}
			});

		const runVerify = (
			root: string,
			commands: readonly string[],
			timeoutMs: number,
		): Effect.Effect<{ ok: boolean; log: string }> =>
			Effect.sync(() => {
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
			});

		return Vcs.of({
			detect,
			isDirty,
			treeFingerprint,
			ensureGitBranch,
			commitPhase,
			setBookmarkAtTerminus,
			runVerify,
		});
	}),
);
