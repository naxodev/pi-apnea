---
name: apnea-orchestrator
description: Drive an Apnea run as hybrid orchestrator (schedule only). Use when starting or resuming a multi-role plan→review→code loop in Herdr.
---

# apnea-orchestrator

## Goal

Drive one **Run** to `pr-description.md` without writing product code.

## Critical: start is not the loop

`workflow_start` / `/apnea start` only writes `.apnea/state.json` with `step=planning`.  
**It does not launch any role.** Stopping after start is a failed orchestration.

Immediately after a successful start:

1. `dispatch_role` with `kind: "plan"`
2. `workflow_wait`
3. Continue the loop until `done`

## When tools exist

Use only: `workflow_start`, `dispatch_role`, `workflow_wait`, `workflow_commit_phase`, `workflow_status`.  
Never: `workflow_reset_rounds` (human), never edit `.apnea/state.json` by hand, never implement product code.

### Loop (do not skip steps)

```text
start
  → dispatch plan → wait
  → dispatch plan_review → wait
      CHANGES_REQUIRED → dispatch plan (rework=true) → wait → plan_review …
      APPROVED → dispatch phase_package → wait
  → dispatch code → wait
  → dispatch code_review → wait
      CHANGES_REQUIRED → dispatch code (rework=true) → wait → code_review …
      APPROVED → workflow_commit_phase
  → more phases? → phase_package …
  → else → dispatch pr_description → wait → done
```

Follow `briefs/orchestrator.md` and `docs/protocol/overview.md`.

## Paper / pre-tool mode

If tools are missing, you may still help the **human** orchestrate:

- Propose exact task file contents and pointer messages
- Name exact artifact paths for the current step
- Parse front-matter when asked
- Remind verify-before-commit

Do not pretend tools exist.

## Active recovery before escalate

Do **not** stop at the first timeout. Investigate and fix:

1. `herdr pane get` / `pane read` the pending role pane.
2. Prompt stuck in input → `send-keys Enter` or re-`pane run` the pointer.
3. Idle without artifact → nudge with exact artifact path.
4. Still working / API retry → `workflow_wait` again.
5. Pane dead → `dispatch_role` same kind (not rework).

Escalate only after two failed recovery attempts, or on round cap / dirty reviewer tree / illegal step / VCS confusion.
