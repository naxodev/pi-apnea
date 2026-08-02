/**
 * Split `--bare` switches from `--key=value` options; everything else is
 * positional. `values` matters: `rest` never sees a `--`-prefixed token, so
 * `--key=value` options are only reachable through the map.
 */
export function parseFlags(tokens: string[]): {
	flags: Set<string>;
	values: Map<string, string>;
	rest: string[];
} {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const rest: string[] = [];
	for (const t of tokens) {
		if (!t.startsWith("--")) {
			rest.push(t);
			continue;
		}
		const body = t.slice(2);
		const eq = body.indexOf("=");
		if (eq > 0) values.set(body.slice(0, eq), body.slice(eq + 1));
		else flags.add(body);
	}
	return { flags, values, rest };
}

/** Reading a `--key=value` numeric flag either yields the parsed number (or
 * `undefined` when the caller didn't pass it) or the raw token that failed
 * to parse, so the caller can name exactly what it received. */
export type NumFlag = { ok: true; value: number | undefined } | { ok: false; raw: string };

/**
 * Shared by `/apnea` and the CLI so a mistyped `--budget=abc` is refused the
 * same way on both surfaces instead of silently falling back to a default —
 * a scripting agent needs a signal, not a quietly-wrong value. `--key=`
 * (empty string) counts as "not provided": a caller who writes it almost
 * certainly forgot the value, not asked for zero.
 */
export function parseNumFlag(values: Map<string, string>, key: string): NumFlag {
	const raw = values.get(key);
	if (raw === undefined || raw === "") return { ok: true, value: undefined };
	const n = Number(raw);
	return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, raw };
}
