# Artifacts

## Layout

```text
.apnea/                          # runtime; ignore in VCS
  config.json                    # optional project role→profile bindings only
  state.json                     # step, phase index, rounds per (phase, gate), slug
  tasks/
    <dispatch-id>.md             # human/agent-readable task payload
  artifacts/
    plan.md                      # or plan-round-N.md on plan rework
    plan-review/
      round-1.md
    phase-01/
      round-1/
        phase-package.md
        coder-result.md
        code-review.md
        verify.log               # written by workflow_commit_phase
    phase-02/
      ...
    pr-description.md
```

Package-owned briefs live in the installed package (`briefs/`), not under `.apnea/`.

## Front-matter schema

Required on every role-produced artifact:

| Field | Values |
|-------|--------|
| `status` | `done` (v1; no partial) |

Review artifacts also require:

| Field | Values |
|-------|--------|
| `verdict` | `APPROVED` \| `CHANGES_REQUIRED` |

Optional:

| Field | Values |
|-------|--------|
| `nits` | freeform markdown string; ignored by commit gate |

Non-review artifacts (plan, phase package, coder result, pr-description): `status: done` only; no `verdict`.

## Clear-before-dispatch

For a given target path, `dispatch_role` deletes or renames away any existing file at that path before sending the pointer so absence means “not done.”

On rework after CHANGES_REQUIRED, the **round number increases** and the path changes (`round-2/...`), so history is preserved.

On crash re-dispatch (same round), the same path is cleared and reused.

## Human markers (optional)

Roles may print `PLAN_READY`, `VERDICT: APPROVED`, etc. for humans. Tools must not depend on them.
