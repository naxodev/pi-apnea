import { describe, expect, test } from "bun:test";
import type { RunState } from "./types.ts";
import { getRound, roundKey, setRound } from "./rounds.ts";

function baseState(): RunState {
	return {
		version: 1,
		slug: "t",
		step: "coding",
		phase_index: 1,
		phase_count_hint: null,
		rounds: {},
		vcs: "jj",
		allow_dirty: false,
		goal: "g",
		last_error: null,
		pending_artifact: null,
		pending_role: null,
		pending_pane_id: null,
		pending_pane_label: null,
		pending_floating_exit: null,
		pending_started_at: null,
		pending_deadline_ms: null,
		pending_nudged_at: null,
		pending_final_grace: false,
		pending_extended: false,
		role_panes: {},
		package_root: "/tmp",
		reviewer_tree_fingerprint: null,
		current_phase_package: null,
		current_code_review: null,
	};
}

describe("rounds", () => {
	test("roundKey shapes", () => {
		expect(roundKey(1, "plan_review")).toBe("plan_review");
		expect(roundKey(1, "finishing")).toBe("finishing");
		expect(roundKey(2, "code_review")).toBe("phase-02/code_review");
	});

	test("getRound defaults to 1; setRound persists", () => {
		const s = baseState();
		expect(getRound(s, "plan_review")).toBe(1);
		setRound(s, "plan_review", 3);
		expect(getRound(s, "plan_review")).toBe(3);
	});
});
