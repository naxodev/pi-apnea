# Protocol overview

## Roles

| Role | Mode | Default job |
|------|------|-------------|
| **orchestrator** | interactive (Pi; tools only) | Drive the loop; no product code |
| **planner** | interactive TUI | Plan, phase packages, final PR description |
| **reviewer** | interactive TUI | Plan review + code review |
| **coder** | interactive TUI | Implement current phase package only |

All worker roles open a **live harness TUI** in a Herdr pane (Claude / Pi / Codex / …). Dispatch never uses oneshot (`-p` / print) — that dumps shell output and is not watchable. Profiles must provide `cmd_interactive` for every role.

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
| `dispatch_role` | Write task file; open live harness TUI in pane; wait idle; submit short pointer; rework-only round increment |
| `workflow_wait` | Wait for artifact front-matter; treat agent-status as liveness only |
| `workflow_commit_phase` | Require APPROVED + verify commands (log to `verify.log`) + VCS backend; advance phase |
| `workflow_status` | **Read-only** snapshot |

Cap reset (`reset-rounds`) is not a Pi tool at all — it exists only as `apnea reset-rounds`
(CLI) and `/apnea reset-rounds` (slash command), both human-only. See [ADR 0002](../adr/0002-orchestrator-authority.md).

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

- **All roles:** live follow-up on the same pane when the harness is still idle; if pane missing or busy → new pane + cold TUI launch, then pointer.
- Pointer always includes prior artifact paths for context.
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
