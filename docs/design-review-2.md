# Apnea second-pass review — locked baseline

Reviewer: Claude Fable 5 · 2026-07-18 · against `apnea-design-locked.md`, follow-up to `apnea-design-review.md`

## Verdict

**Lock with nits — two of them blocking.** The architecture holds: one completion channel, tools-as-state-machine, verify-at-gate, profile-based config with a real trust boundary, label-resolved panes. Nothing in the locked core needs reopening. But two decisions made *after* review-1 quietly reintroduce the exact failure classes review-1 removed, and both must be fixed on paper before the paper protocol is written:

1. **`reset_rounds` lives on `workflow_status` and inside the orchestrator's allowlist.** The round cap is your only guardrail against an orchestrator looping forever — and you handed the orchestrator the key to it. This is the `tools: readonly` config-lie pattern again: a guardrail that doesn't guard. (Nit #1.)
2. **`prompt_via` is a profile property, but cold-vs-live is locked per role.** A user can bind the planner to a keystrokes profile and silently violate the "planner/reviewer always cold" policy. Policy that config can contradict without error is not policy. (Nit #2.)

Both are one-paragraph spec fixes, not architecture changes — hence "lock with nits" rather than "reopen." Everything else below is residual risk to watch or genuine nit.

## Residual risks (still dangerous after the lock)

1. **Live-keystroke dispatch to the coder is the last unvalidated mechanical bet.** Cold roles are now just "run command, wait for file" — near-zero risk. But sending a pointer (and later, rework follow-ups) into a live TUI's input loop is timing- and state-sensitive: paste bracketing, newline-as-submit differences, the harness sitting in a modal or mid-tool-call when keystrokes arrive. Everything else in the design has a fallback; garbled keystrokes into a live pane just produce a confused agent. The bootstrap gate as written does **not** force this path hard enough — see the bootstrap section.
2. **Resume is named but not specified — and it interacts badly with round accounting.** "Refuse unless resume/abandon" says when resume happens, not what it does. The dangerous sub-case: crash during `coding`, human resumes, orchestrator re-dispatches — `dispatch_role` increments the round, so a crash consumed a rework round the coder never got. Two crashes and a legitimate rework later, the run hits the cap having done one real round. Resume needs a reconcile definition (nit #4) and round increments need a tighter rule (nit #3).
3. **The phase package is the only unreviewed artifact in the loop.** Plan is reviewed; code is reviewed; the phase package — the contract that bounds the coder — is emitted by the planner and consumed unreviewed. A phase package that drifts from the approved plan is caught only at code review, after burning a full 45-minute coding round. Acceptable v1 trade (an extra review round-trip per phase is worse), but it deserves one cheap mitigation: the code-review brief must instruct the reviewer to check the phase package against `plan.md` *first* and issue CHANGES_REQUIRED-against-the-package before reading any code. Cost: one paragraph in a brief.
4. **Verify-command execution: accept, don't sandbox — but log it.** Confirming review-1's position against the "attack" list: sandboxing planner-authored verify commands while the coder writes source code that those commands execute is security theater; same trust domain, no new exposure. Two cheap hardenings: (a) verify output is written to `artifacts/phase-N/verify.log` so the gate's evidence is auditable, and (b) the plan-review brief tells the reviewer that approving a plan includes sanity-reading its verify commands. Then accept, and say so in the verify-at-gate ADR.
5. **Dirty-tree detection must be defined as file-content diff, not VCS activity.** In a jj repo, *any* `jj` command by any role snapshots the working copy into `@` — the reviewer running `jj diff` (legitimate, readonly-in-spirit) mutates the op log. If "dirtied the tree" is implemented as "VCS state changed," the reviewer trips it every time. Spec must say: snapshot = file content hash/diff summary; op-log and snapshot churn are ignored.

## Nits worth fixing before paper protocol

1. **Split `reset_rounds` out of `workflow_status`; keep it out of the orchestrator allowlist.** *(Blocking.)* `workflow_status` returns to pure read — its whole identity since review-1 — and the cap reset becomes a human-only act: either a sixth tool (`workflow_reset_rounds`) absent from the orchestrator's allowlist, or a documented human-side invocation. The tool count growing to six is fine; a mutating verb hiding inside the status tool and a self-resettable cap are not. Fold into the *orchestrator authority* ADR.
2. **Invert `prompt_via` ownership: mode is fixed by role, profiles declare what they support.** *(Blocking.)* Profiles declare `cmd_oneshot` and/or `cmd_interactive`; the protocol pins each role's mode (planner/reviewer/pr-writer: oneshot; coder: interactive). Binding a role to a profile lacking the required variant **hard-errors at `workflow_start`** — same posture as the `isolation: worktree` rule. This deletes the mismatch class entirely instead of documenting it. Also resolves the latent question of what `workflow_start` spawns for cold roles: cold roles get a labeled shell pane in which dispatch runs the one-shot (observability preserved); "liveness" for a cold dispatch is simply "process exited without artifact → escalate," no idle-timeout heuristics.
3. **Define round increment as rework-only.** Replace "increment round when applicable" with: the round number increments **only** when dispatching in response to a `CHANGES_REQUIRED` verdict on the same gate; re-dispatch after crash/timeout/resume reuses the current round number (same artifact path, clear-before-dispatch). Rounds are scoped per **(phase, gate)** in `state.json` — the locked doc never says this, and an unscoped counter would let phase 1's rework rounds starve phase 4.
4. **Write the reconcile procedure — resume never auto-dispatches.** Resume = re-resolve panes by label, then reconcile: for the in-flight step, if the expected artifact exists with valid front-matter → ingest it and advance; if absent → report state to the human and *offer* re-dispatch (same round, per nit #3). A live coder pane that survived the crash must be waited on, not blindly re-dispatched over. Resume obviously skips the clean-tree check (mid-phase coder work is legitimately dirty) — say so, or the refuse-on-dirty rule strands every resumed run. This answers the fifth "attack" bullet; it's a page in the state-machine spec, not a new mechanism.
5. **Assign `pr-description.md` a producer.** The loop terminates "→ pr-description.md" with no role attached. Give it to the planner as a final cold dispatch (it owns the plan and phase history), artifact with `status` front-matter only (no verdict — it's a terminus, not a gate). One row in the protocol table.
6. **jj bookmark timing: create at terminus, not at start.** jj bookmarks don't follow `@`; a bookmark created by `workflow_start` points at the pre-run change forever unless every `workflow_commit_phase` moves it. Either move it per commit or (simpler, more idiomatic for your squash workflow) create it once at the pr-description terminus. For git the branch-at-start stays. Belongs in the *jj-first commit semantics* ADR; also define there that "clean tree" means empty `@` in jj terms.

## The five "attack these if still soft" bullets, answered

| Soft spot | Answer |
|---|---|
| Cold/live `prompt_via` mismatch | Real footgun as specced; dissolved by nit #2 (role owns mode, profiles declare variants, mismatch hard-errors). |
| `reset_rounds` enough, or first-class `workflow_abandon`? | `reset_rounds` suffices **only** after nit #1 (human-only, out of status). No abandon tool: abandon-at-start already exists, and mid-run abandon is "stop, then `workflow_start` → abandon" — a new tool would add a verb for a path the existing one covers. |
| Profile rebind without `cmd` — enough for Anthropic↔OpenAI? | Yes. Stack switches are edits to `~/.config/apnea` profiles the user owns; projects rebinding roles→profiles covers per-repo variation. The cost — a quick per-run model experiment requires pre-defining a global profile — is the trust boundary working as designed. Don't soften it. |
| Verify commands: accept or sandbox? | Accept (same trust domain as the coder), with verify.log + reviewer-reads-verify-commands per residual risk #4. Record the acceptance in the ADR. |
| Resume underspecified? | Yes — the sharpest true criticism in the list. Nit #4 is the fix; without it, resume plus round accounting (nit #3) silently burns the cap. |

## Bootstrap gate: confirm, with three additions

The gate is right in kind — paper protocol first, manual run before tool code, zero manual verdict transcription. But as written, the 2-phase happy-path toy validates the *easy* half (cold one-shots writing front-matter) and skips the three paths most likely to fail in dogfood. Add to the manual run's exit criteria:

1. **At least one forced `CHANGES_REQUIRED` on code and one on plan** — the code one exercises the live-keystroke rework follow-up into an existing coder pane, which is residual risk #1 and otherwise goes completely untested until dogfood.
2. **One kill-and-resume:** kill the coder pane (or the whole session) mid-phase, then walk the reconcile procedure by hand — validating nit #4's spec while it's still paper.
3. **One `nits`-bearing `APPROVED`** — confirming the front-matter schema's optional field parses and that nits demonstrably don't block the gate.

Still zero manual verdict transcription throughout, including the rework and resume paths. If the manual run passes with these three, the protocol has earned tool code; if the live-keystroke rework proves flaky in the manual run, you'll want to know *before* `dispatch_role` exists — the fallback (demote the coder to cold respawn-with-context, already the pane-death policy) is a one-line policy change on paper and a redesign after.

## Bottom line

Lock it. Fix nits #1 and #2 in the baseline doc before writing the paper protocol — they are the two places where the post-review-1 decisions recreated patterns review-1 existed to kill (a guardrail the guarded party can disable; a policy the config can contradict silently). Nits #3–#6 land in the ADRs/spec during step 1 of bootstrap. The bootstrap gate stands, with the three added exit criteria.
