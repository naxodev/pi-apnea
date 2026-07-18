---
name: apnea-orchestrator
description: Drive an Apnea run as hybrid orchestrator (schedule only). Use when starting or resuming a multi-role plan→review→code loop in Herdr.
---

# apnea-orchestrator

## Goal

Drive one **Run** to `pr-description.md` without writing product code.

## When tools exist

Use only: `workflow_start`, `dispatch_role`, `workflow_wait`, `workflow_commit_phase`, `workflow_status`.  
Never: `workflow_reset_rounds` (human), never edit `.apnea/state.json` by hand.

Follow `briefs/orchestrator.md` and `docs/protocol/overview.md`.

## Paper / pre-tool mode

If tools are missing, you may still help the **human** orchestrate:

- Propose exact task file contents and pointer messages
- Name exact artifact paths for the current step
- Parse front-matter when asked
- Remind verify-before-commit

Do not pretend tools exist.

## Escalate

Timeouts, dead panes, round cap, reviewer dirty tree, VCS confusion, or illegal step — stop and report via status-style summary for the human.
