# Apnea locked baseline (final)

Accepted after grill + Fable review-1 + Fable review-2. This is the authority for paper protocol.

## Product

- **Package:** `@naxodev/apnea`
- **Repo:** `~/work/1-projects/naxodev/pi-apnea`
- **Shape:** B + thin C (skills, briefs, templates, setup skill) + extension tools
- **Not:** hidden subagents, config UI (v1), Herdr plugin, parallel coders

## Glossary

| Term | Meaning |
|------|---------|
| **Run** | One goal → PR-description loop |
| **Phase** | Planner-cut vertical slice |
| **Phase package** | Dispatch contract for one phase |
| **Dispatch** | One role assignment |
| **Round** | Rework iteration within a (phase, gate); increments only on CHANGES_REQUIRED |
| **Verdict** | `APPROVED` \| `CHANGES_REQUIRED` (+ optional `nits`) |
| **Brief** | Role identity doc (package-owned) |
| **Artifact** | Role output file (run-owned) |
| **Gate** | Tool-enforced precondition (verdict, verify, step) |
| **Profile** | Global named cmd template(s) + supported modes |

## Loop

```
goal
  → workflow_start
  → planner: plan.md
  → reviewer: PLAN_REVIEW
  → [rework plan ≤ cap]
  → planner: phase package
  → coder: implement phase only
  → reviewer: CODE_REVIEW (phase package vs plan first, then code)
  → [rework code ≤ cap]
  → workflow_commit_phase (APPROVED + verify cmds + VCS)
  → repeat until no phases
  → planner: pr-description.md (final cold dispatch)
```

## Tools

| Tool | Mutates? | In orchestrator allowlist? |
|------|----------|------------------------------|
| `workflow_start` | yes | yes |
| `dispatch_role` | yes | yes |
| `workflow_wait` | no (advances step only on valid artifact) | yes |
| `workflow_commit_phase` | yes | yes |
| `workflow_status` | **no** (read-only) | yes |
| `workflow_reset_rounds` | yes | **no** (human-only) |

## Control plane

1. Completion = artifact front-matter only (`status`, `verdict?`, `nits?`)
2. Tools enforce `state.json.step`
3. Commit runs verify commands; writes `verify.log`
4. Paths: `.apnea/artifacts/phase-N/round-M/...`
5. Profiles global-only for `cmd`; project rebinds role→profile
6. Role owns mode: planner/reviewer/pr-writer = oneshot; coder = interactive
7. Profiles declare `cmd_oneshot` and/or `cmd_interactive`; mismatch hard-errors
8. Panes by role label; no cached IDs
9. One run per repo; resume/abandon; resume never auto-dispatches
10. Round counter per (phase, gate); increment only on CHANGES_REQUIRED rework
11. Dirty start refuse (allow-dirty override); resume skips clean-tree
12. Reviewer dirty-tree = file content, not jj op-log
13. jj bookmark at terminus; git branch at start
14. No memory/ in v1
15. Setup: skill + `/apnea-init` + docs; no config UI

## Bootstrap gate (before tool code)

Manual 2-phase toy with claude planner/reviewer + pi coder:

- [ ] Zero manual verdict transcription
- [ ] Forced CHANGES_REQUIRED on plan and on code (live coder rework)
- [ ] Kill-and-resume mid-phase
- [ ] One APPROVED with nits

## Out of v1

Worktrees, npm polish, promote-to-docs, parallel coders, memory, native CLAUDE.md injection, GUI, push/PR, force-approve, auto-stash, config UI
