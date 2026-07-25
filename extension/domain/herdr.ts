import type { PaneStyle, Role } from "./types.ts";

/** Parse `herdr X.Y.Z` (or noisy multi-line) into a numeric tuple. */
export function parseHerdrVersion(
	raw: string,
): [number, number, number] | null {
	const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function versionGte(
	a: [number, number, number],
	b: [number, number, number],
): boolean {
	const [a0, a1, a2] = a;
	const [b0, b1, b2] = b;
	if (a0 !== b0) return a0 > b0;
	if (a1 !== b1) return a1 > b1;
	return a2 >= b2;
}

/**
 * Floating popups need herdr ≥ 0.7.4. Fail closed on unparseable versions so an
 * unattended run never hangs on a CLI that rejects `--placement popup`.
 */
export function supportsFloating(
	version: [number, number, number] | null,
): boolean {
	return version != null && versionGte(version, [0, 7, 4]);
}

/**
 * Configured style vs effective style. Floating is only for planner/reviewer
 * (oneshot-eligible artifact producers); interactive roles always stay regular.
 */
export function effectivePaneStyle(
	configured: PaneStyle,
	role: Role,
): { style: PaneStyle; effective: string } {
	if (configured === "regular") {
		return { style: "regular", effective: "regular" };
	}
	if (role === "planner" || role === "reviewer") {
		return { style: "floating", effective: "floating" };
	}
	return { style: "regular", effective: "regular (interactive role)" };
}

export function shellJoin(parts: string[]): string {
	return parts
		.map((p) => {
			if (p === "&&" || p === "|" || p === "exec" || p === "env") return p;
			if (/^[A-Za-z0-9_./:=,@+-]+$/.test(p)) return p;
			return `'${p.replace(/'/g, `'\\''`)}'`;
		})
		.join(" ");
}

/** True when every foreground process name looks like a bare shell prompt. */
export function looksLikeShellOnly(names: string[]): boolean {
	if (names.length === 0) return false;
	return names.every((n) => {
		const t = n.trim();
		return (
			/^(zsh|bash|sh|fish)$/i.test(t) ||
			t === "-zsh" ||
			t === "-bash" ||
			t === "-sh"
		);
	});
}

/** Parse a floating task's exit-file contents; null if not a finished exit code. */
export function parseFloatingExit(text: string): number | null {
	const t = text.trim();
	const n = Number.parseInt(t, 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * Self-contained bash script body that cds to root, runs cmd + prompt as a
 * child (not exec — so EXIT trap still fires), and always records the exit
 * code for workflow_wait. Popups have no pane id; the exit file is the
 * liveness signal.
 */
export function floatingTaskScriptBody(opts: {
	root: string;
	resolvedCmd: string[];
	prompt: string;
	exitFileAbs: string;
}): string {
	return [
		"#!/bin/bash",
		"set -uo pipefail",
		`EXIT_FILE=${shellJoin([opts.exitFileAbs])}`,
		"write_exit() {",
		"  local st=$?",
		`  printf '%s\n' "$st" > "$EXIT_FILE" 2>/dev/null || true`,
		"}",
		"trap write_exit EXIT",
		"trap 'exit 129' HUP",
		"trap 'exit 130' INT",
		"trap 'exit 143' TERM",
		shellJoin(["cd", opts.root]),
		shellJoin([...opts.resolvedCmd, "--", opts.prompt]),
		"",
	].join("\n");
}
