import type { FrontMatter, Verdict } from "../lib/types.ts";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontMatter(text: string): FrontMatter | null {
	const m = text.match(FM_RE);
	if (!m) return null;
	const raw = m[1] ?? "";
	const body = m[2] ?? "";
	const fields: Record<string, string> = {};
	let currentKey: string | null = null;
	let currentVal: string[] = [];

	const flush = () => {
		if (currentKey) {
			fields[currentKey] = currentVal
				.join("\n")
				.replace(/^\s*\|\s*\n?/, "")
				.trimEnd();
		}
		currentKey = null;
		currentVal = [];
	};

	for (const line of raw.split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
		if (kv) {
			flush();
			currentKey = kv[1]!;
			const rest = kv[2] ?? "";
			if (rest === "|" || rest === ">") {
				currentVal = [];
			} else {
				currentVal = [rest];
			}
		} else if (
			currentKey &&
			(line.startsWith("  ") || line.startsWith("\t") || line === "")
		) {
			currentVal.push(line.replace(/^\s{2}/, ""));
		}
	}
	flush();

	return {
		status: fields.status,
		verdict: fields.verdict,
		nits: fields.nits,
		raw,
		body,
	};
}

export function isCompleteArtifact(
	fm: FrontMatter | null,
	opts: { requireVerdict?: boolean } = {},
): boolean {
	if (!fm || fm.status !== "done") return false;
	if (opts.requireVerdict) {
		return fm.verdict === "APPROVED" || fm.verdict === "CHANGES_REQUIRED";
	}
	return true;
}

export function asVerdict(v: string | undefined): Verdict | null {
	if (v === "APPROVED" || v === "CHANGES_REQUIRED") return v;
	return null;
}
