# Protocol overview

## Roles

| Role | Mode | Default job |
|------|------|-------------|
| **orchestrator** | interactive (Pi; tools only) | Drive the loop; no product code |
| **planner** | oneshot | Plan, phase packages, final PR description |
| **reviewer** | oneshot | Plan review + code review |
| **coder** | interactive | Implement current phase package only |

Mode is **owned by the role**, not the profile. Profiles must provide the matching command variant (`cmd_oneshot` / `cmd_interactive`).

## State machine (`state.json.step`)

```text
start
  → planning
  → plan_review
  → phase_packaging
  → coding
  → code_review
  → committing
  → (phase_packaging | finishing)
  → finishing          # planner writes pr-description
  → done
```

Illegal tool calls refuse with the legal next call named in the error.

## Tools

| Tool | Purpose |
|------|---------|
| `workflow_start` | Resolve config; clean-tree check (unless allow-dirty / resume); create git branch or prepare jj; label panes; write state |
| `dispatch_role` | Write task file; set target artifact path; send pointer; rework-only round increment |
| `workflow_wait` | Wait for artifact front-matter; treat agent-status as liveness only |
| `workflow_commit_phase` | Require APPROVED + verify commands (log to `verify.log`) + VCS backend; advance phase |
| `workflow_status` | **Read-only** snapshot |
| `workflow_reset_rounds` | Human-only; not on orchestrator allowlist |

## Dispatch pointer (all harnesses)

Short message only, e.g.:

```text
You are the reviewer.
Read brief: <package>/briefs/reviewer.md
Read task: .apnea/tasks/<id>.md
Write artifact exactly at: .apnea/artifacts/phase-03/round-2/code-review.md
Follow the brief. Do not invent paths.
```

## Completion

Machine channel: **artifact front-matter only**.

```yaml
---
status: done
verdict: APPROVED   # or CHANGES_REQUIRED; omit for non-review artifacts
nits: |             # optional; never blocks alone
  Consider renaming foo later.
---
```

Pane markers are human decoration. Herdr `agent_status` is liveness (dead pane / hung oneshot without artifact → escalate).

## Rework

- **Plan / review / planner PR:** always cold oneshot; pointer includes prior artifact paths.
- **Coder:** live follow-up on same pane when possible; if pane missing → cold respawn with artifacts.
- Round increments **only** after CHANGES_REQUIRED on the same (phase, gate).
- Crash / timeout / resume: **same round number**, clear-before-dispatch on that path.

## Resume

1. Re-resolve panes by role label (respawn if needed).
2. If expected artifact has valid front-matter → ingest and advance.
3. Else report state; **offer** re-dispatch — never auto-dispatch.
4. Skip clean-tree check on resume.

## Commit

- Orchestrator only.
- `workflow_commit_phase` runs phase package verify commands; non-zero → refuse.
- jj: `jj describe` + `jj new` after APPROVED; **bookmark `apnea/<slug>` at terminus**, not start.
- git: branch `apnea/<slug>` at start; one commit per phase.
- No push / remote PR in v1. Terminus artifact: `pr-description.md` (planner).

## Concurrency

One run per repo. Existing `state.json` → resume or abandon only.
