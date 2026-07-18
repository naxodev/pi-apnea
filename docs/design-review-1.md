# Apnea design review

Reviewer: Claude Fable 5 · 2026-07-18 · against `apnea-design-brief.md`

## Verdict

**Ship with changes — substantial ones.** The scope cut is honest, the bootstrap order (paper protocol → manual run → tools) is correct, and file-backed handoffs are the right bet. But the control plane is over-built in exactly the places the brief itself flags as risks: three completion channels where one suffices, a dispatch-ID correlation scheme a sequential loop doesn't need, an LLM orchestrator trusted to execute a deterministic state machine, and a "readonly" config knob that mostly does nothing. Fix the control plane before writing any tool code; if you skip that, this is a "rethink."

The single decision closest to a rethink: **who owns the loop.** The loop in the brief is a deterministic state machine, and you're assigning it to your least reliable component (Pi+Grok freestyle risk, tension #2) doing your most mechanical job. You don't have to abandon the agent-orchestrator philosophy, but the tools must *be* the state machine, not suggestions to it. Details in improvement #2.

## Top risks (ordered)

1. **Non-Pi harness protocol compliance is the load-bearing wall, and the design leans on it three times per dispatch.** Claude/Codex must (a) read the brief file, (b) read the task file, (c) write a well-formed `result.json` with the right `dispatch_id` and verdict enum. Every extra obligation multiplies the failure rate. The design's own fallback chain (result file → marker → agent-status + parse artifact) is an admission that the primary channel will fail; the last fallback — parsing a verdict out of freeform markdown — is the most fragile parser in the system and it's the one that runs when everything else already failed.
2. **Orchestrator freestyle corrupts state irrecoverably.** A Grok orchestrator that skips `workflow_wait`, dispatches the coder before plan approval, or hand-edits `state.json` via bash leaves you with a run whose state file lies. Only `workflow_commit_phase` currently validates preconditions; the other four tools will do whatever they're told, in any order.
3. **Verification is unassigned.** Phase packages carry verify commands, but no role is designated to run them, and the reviewer — the natural candidate — is nominally readonly (can't run builds/tests). As written, "APPROVED" can mean "the coder said the tests pass." That's the exact failure mode artifact-based workflows exist to prevent.
4. **Project-local config is arbitrary code execution.** `.pi-herdr/config.json` lives in the repo and defines `harnesses.*.bin`. Clone a malicious repo, run `workflow_start`, execute attacker-chosen binaries. Tension #9 undersells this: it's not "prompts are repo-controlled," it's "argv is repo-controlled."
5. **`state.json` and reality diverge silently.** Stale pane IDs (tension #3), a human taking over a pane, a crashed harness, a killed Herdr session, or two workflow runs in one repo — none of these are detected, and there's no resume story. First real dogfood session will hit at least two of these.
6. **`current-*` artifact overwriting destroys the audit trail.** Round 2 of a code review clobbers round 1; phase 3's plan review clobbers phase 2's. When a run goes wrong (it will, you're dogfooding), you'll have no history to debug the protocol with — and debugging the protocol is the whole point of v1.
7. **Cross-harness config semantics are hand-waved.** `"model": "fable"` means nothing to `claude` without `--model`, and `"tools": "readonly"` has no cross-harness meaning at all. Also unspecified: how a prompt physically reaches an interactive TUI pane (keystrokes? `-p`? stdin?), which differs per harness and is the part that actually breaks.

## Concrete improvements

### 1. One completion channel: verdict front-matter in the artifact, clear-before-dispatch

- **Problem:** Three completion signals (result.json, pane markers, agent-status+parse) and a `dispatch_id` correlation scheme — for a *sequential* loop with at most one outstanding dispatch. Three sources of truth means three parsers, three staleness bugs, and a priority ladder to document.
- **Proposal:** The artifact is the only machine channel. Every role writes exactly one artifact per dispatch, with required YAML front-matter: `status: done`, `verdict: APPROVED | CHANGES_REQUIRED | null`. `dispatch_role` deletes (or archives, per #4) the target artifact before sending the pointer; `workflow_wait` waits for the file to exist with parseable front-matter. Staleness is solved by absence, not by ID matching — kill `dispatch_id` entirely. Keep pane markers as human-facing decoration only; `workflow_wait` never reads them. Keep Herdr agent-status solely as a *liveness* check (pane died / pane idle with no artifact → escalate), never as a completion signal.
- **Why better:** One obligation for foreign harnesses instead of three ("write this file with this header" is the easiest possible instruction to comply with). One parser. No ID bookkeeping. The failure mode collapses to "artifact missing or malformed → escalate to human," which is the correct v1 behavior anyway.
- **v1.** ADR-worthy: *completion signaling*.

### 2. Tools enforce the state machine; the orchestrator only drives it

- **Problem:** The loop is deterministic but its executor is a stochastic model. Nothing stops out-of-order tool calls or bash-based state mutation.
- **Proposal:** `state.json` gains an explicit `step` field (`planning → plan_review → phase_packaging → coding → code_review → committing → …`). Every tool validates the current step and **refuses with a corrective error message** on illegal transitions (`dispatch_role coder` while step is `plan_review` → error naming the legal next call). Tools are the only writer of `state.json`; the orchestrator brief forbids editing it and the schema docs say hand-edits void the warranty. The orchestrator's genuine decisions shrink to: proceed vs. escalate on CHANGES_REQUIRED, and when to interrupt for the human — which is exactly the judgment an LLM is for.
- **Why better:** A freestyling Grok can now waste a turn but cannot corrupt a run. You keep the "agent runs the loop, human can grab the wheel" philosophy while making the worst case boring. This also answers tension #8 correctly: thin C isn't too fat — it's too *permissive*. Same five tools, but load-bearing.
- **v1.** ADR-worthy: *orchestrator authority model*. (Later: an `apnea run` deterministic driver script becomes trivial to add on top of the same tools, if the LLM orchestrator proves worthless even as a driver.)
- **Rejected alternative, be honest about it:** making the whole loop a Bun script now. It's fewer moving parts, but it abandons the hybrid-orchestrator premise before dogfooding tests it. Guardrailed tools let you run the experiment cheaply and downgrade later without redesign.

### 3. Commit gate runs the verify commands

- **Problem:** Verify commands exist in the phase package but nobody is assigned to run them; approval currently rests on LLM claims.
- **Proposal:** `workflow_commit_phase` executes the phase package's verify commands and refuses to commit on any non-zero exit — in addition to requiring APPROVED. The coder's brief still says "run the checks and paste output into your result artifact" (so the reviewer can audit), but the *gate* is exit codes, not prose. The reviewer stays readonly and audits diffs + claimed outputs.
- **Why better:** The only hard quality gate in the system stops trusting model self-reports. It also resolves the "reviewer can't run tests" contradiction without weakening readonly. Yes, planner-authored verify commands are arbitrary code — but that's the same trust domain as the coder editing source, so it adds no new exposure.
- **v1.** This is the highest-leverage single change in the review.

### 4. Per-phase artifact directories; kill the `current-*` pattern

- **Problem:** Overwriting `current-phase.md` / `current-code-review.md` each round erases exactly the history you need to debug the protocol during dogfooding.
- **Proposal:** `artifacts/phase-03/round-2/code-review.md` style paths. Roles never need stable paths — they get the exact path in the dispatch pointer message, so this costs nothing at dispatch time. `plan.md` and `pr-description.md` can stay top-level and versioned by suffix on rework.
- **Why better:** Full audit trail per run for free; "clear-before-dispatch" from #1 becomes unnecessary for round-scoped paths (a fresh path is always absent). One convention replaces two (`current-*` + archival-later).
- **v1.**

### 5. Rename `.pi-herdr/` → `.apnea/`; write the glossary

- **Problem:** Tension #5 is right: the package is Apnea, the dir is pi-herdr. It also welds the artifact layout to two brand names, one of which (Herdr) is an implementation detail you already imagine swapping.
- **Proposal:** `.apnea/`. Glossary (ubiquitous language, per the mandate): **Run** (one goal → PR loop), **Phase** (planner-cut vertical slice), **Phase package** (the dispatch contract for one phase), **Dispatch** (one role assignment), **Round** (rework iteration within a dispatch, cap 3), **Verdict** (APPROVED / CHANGES_REQUIRED), **Brief** (role identity doc, package-owned), **Artifact** (role output file, run-owned), **Gate** (a tool-enforced precondition: verdict gate, verify gate). Use these words verbatim in briefs, tool errors, and docs.
- **Why better:** Tool error messages, briefs, and docs all quoting one vocabulary is what makes foreign harnesses comply — they're pattern-matching your language.
- **v1** (rename is free now, expensive after dogfooding). ADR-worthy: *naming + artifact layout*.

### 6. Readonly reviewer: detect, don't pretend to prevent

- **Problem:** `"tools": "readonly"` is enforceable in some harnesses (claude `--allowedTools`), meaningless in others. A knob that silently does nothing on half the matrix is worse than no knob — it's false safety (tension #6).
- **Proposal:** Delete the `tools` key from role config. Enforcement is per-harness argv (put `--allowedTools …` in the reviewer's launch args where supported — see #7). Universal mechanism is *detection*: `dispatch_role` for a reviewer records tree state (`jj diff --summary` / `git status --porcelain` snapshot); `workflow_wait` re-checks after the verdict and escalates to human if the reviewer dirtied the tree.
- **Why better:** Detection is harness-agnostic and honest. The config no longer promises what it can't deliver.
- **v1** detection; **later** any richer per-harness capability mapping.

### 7. Collapse harness+model config into an argv template per role

- **Problem:** `harness` + `model` + implicit flag-mapping is a leaky abstraction: `fable` vs real CLI IDs (tension #7), different flags per binary, and no story for how the prompt is delivered to the pane.
- **Proposal:** A role is `{ "cmd": ["claude", "--model", "fable", "--allowedTools", "Read,Grep"], "prompt_via": "keystrokes" }` (or `"stdin"` / `"flag:-p"` per harness). The `harnesses` section shrinks to reusable cmd fragments *defined only in global config* (see #8). Keep the global → project → per-run resolution order, but resolution merges role entries wholesale — no per-key deep-merge cleverness in v1.
- **Why better:** Zero translation layer to maintain; adding Codex support is writing an example config, not writing code. `prompt_via` forces the one genuinely unsolved mechanical question (how text reaches each TUI) to be answered per-harness explicitly instead of discovered as a bug.
- **v1.** ADR-worthy: *harness abstraction level*.

### 8. Security: project config cannot name binaries; unknown config hard-errors

- **Problem:** Repo-controlled `bin` = arbitrary code execution on `workflow_start` (risk #4). Separately, the `"isolation": "worktree"` stub key invites config that silently no-ops.
- **Proposal:** Binaries and cmd arrays resolve **only** from global (`~/.config/apnea/…`) config; project config may select among globally defined roles/harnesses and override models/caps, never argv. Any unknown key, or a known key with an unimplemented value (`isolation: "worktree"` in v1), is a hard error at `workflow_start` — not a warning, not a silent default. Document that briefs/tasks/plan content is repo-influenced prompt text (accepted, disclosed injection surface).
- **Why better:** Closes the only RCE-class hole in the design for one paragraph of resolution logic. Hard-error-on-unknown keeps the config surface honest and makes the v2 worktree upgrade a visible behavior change instead of a silent one.
- **v1**, non-negotiable. ADR-worthy: *config trust model*.

### 9. Panes: resolve by role label, never store pane IDs

- **Problem:** Stored pane IDs go stale (tension #3); closed/replaced panes strand the run.
- **Proposal:** `workflow_start` labels panes by role (`apnea:reviewer`); every tool resolves label → pane through Herdr at call time and respawns a missing pane from role config. `state.json` stores role names and the run's protocol state only — Herdr is the sole authority on pane existence. `workflow_start` on an existing `state.json` refuses with "resume or abandon?" rather than clobbering; that plus label re-resolution *is* the v1 resume story.
- **Why better:** Deletes an entire class of staleness bugs by deleting the cached data that goes stale. Human closing/reopening panes — the core hybrid gesture — becomes a non-event.
- **v1.**

### 10. Cut `memory/` from v1

- **Problem:** `memory/project-memory.md` appears in the tree, but no tool writes it, no brief mentions it, and memory auto-summarization is explicitly out of scope. It's a load-bearing-looking file with no writer.
- **Proposal:** Delete the directory from the v1 schema. Reintroduce when something writes and reads it.
- **Why better:** Every schema element you ship becomes a compatibility promise. Don't promise dead weight.
- **v1** (as a cut); **later** with an owner.

**ADRs to write** (the brief asked): completion signaling (#1), orchestrator authority (#2), verify-at-gate (#3), artifact layout + naming (#4/#5), harness abstraction (#7), config trust model (#8), jj-first commit semantics (describe+new mapped to "one commit per phase," and what "commit" means in a repo where jj snapshots everything into `@` continuously — for git users this needs a written explanation, per tension #4).

## Open questions

1. **Prompt delivery mechanics** — per harness, concretely: keystrokes into a TUI vs `-p`/stdin one-shot? One-shot modes exit after responding, which changes rework rounds from "send follow-up to live pane" to "respawn with context." This decision reshapes `dispatch_role` and is currently unmade.
2. **Dirty tree at `workflow_start`** — refuse? Require a clean `@` / clean index? Silently absorbing pre-existing edits into phase 1's commit is the worst outcome; pick refuse and say so.
3. **Git-backend branch semantics** — who creates the task branch, from where, and is push/PR-open in scope or is `pr-description.md` the terminus? (Recommend: terminus; human pushes.)
4. **Rework context** — on CHANGES_REQUIRED, does the coder pane retain conversational context (live pane, follow-up pointer) or start cold from artifacts? Cold-start is more file-handoff-pure and more reproducible; live-pane is cheaper. The brief doesn't choose.
5. **Verdict granularity** — is "APPROVED with nits" a thing? If yes, do nits carry into the next phase package or die? Two-value verdicts are cleaner; decide explicitly.
6. **Round-cap accounting under human intervention** — when the human takes over a pane, edits the plan by hand, or re-dispatches manually, do round counters reset? Undefined counters plus a hard cap will strand runs.
7. **Concurrency** — two runs in one repo (or one run started while a stale `state.json` exists) — locked out by #9's refuse-on-existing-state, but say so in the docs.
8. **Timeout defaults** — "short wait then escalate" needs numbers per step (planning can legitimately take 10+ minutes on Fable; a hung pane looks identical).
9. **Cost posture** — Fable reviewer runs on every rework round of every phase; a 6-phase run at cap is ~24 Fable invocations. Acceptable, or does the reviewer model degrade for round ≥2? (Fine to accept; just decide consciously.)

## Tightened v1 acceptance checklist

Every item is observable/testable; nothing is "docs exist" without a check attached.

**Protocol & compliance**
- [ ] Paper-protocol manual run (human as orchestrator) completes a 2-phase toy feature with `claude` planner/reviewer and `pi` coder, with **zero** manual verdict transcription — every verdict read from artifact front-matter. This gate passes **before** any tool code is written.
- [ ] All three target harnesses (pi, claude, codex), given only the pointer message, produce a front-matter-valid artifact in ≥ 9/10 dispatches; the failure case ends in human escalation, never a hang or a mis-parsed verdict.

**Tools & state machine**
- [ ] Every tool called out of order returns an error naming the legal next step; no tool call in any order can leave `state.json` unparseable or a run unresumable.
- [ ] `workflow_commit_phase` refuses when: verdict ≠ APPROVED, any verify command exits non-zero, or VCS backend is neither jj nor git. All three refusals have a test.
- [ ] `workflow_wait` distinguishes: artifact ready / pane alive-but-idle past timeout / pane dead — and escalates the latter two.
- [ ] Reviewer dirty-tree detection fires: a test run where the "reviewer" mutates a file ends in escalation, not commit.
- [ ] `workflow_start` on an existing `state.json` refuses with resume/abandon; after `herdr` pane close + reopen mid-run, the next tool call succeeds via label re-resolution.

**Config & security**
- [ ] Project config attempting to set `cmd`/`bin` is rejected; unknown keys and `isolation: "worktree"` hard-error at start.
- [ ] Global → project → per-run resolution has tests for each layer winning.

**VCS**
- [ ] jj repo: one described change per phase via `describe` + `new`; **zero mutating git commands** executed (asserted, e.g. via wrapper/log).
- [ ] git repo: one commit per phase on a task branch; coder-authored commits detected and escalated.
- [ ] Repo with neither `.jj` nor `.git`: `workflow_start` refuses.

**Artifacts**
- [ ] After a full run, `artifacts/phase-N/round-M/` contains every plan review, phase package, coder result, and code review produced — nothing overwritten.
- [ ] `pr-description.md` exists and references the actual phases committed.

**Dogfood**
- [ ] Apnea's final v1 feature is implemented by an Apnea run, and the run's artifact trail is committed to the repo as the demo.
