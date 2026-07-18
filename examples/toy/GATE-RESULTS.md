# Manual gate results — 2026-07-18

**Toy repo:** `~/work/1-projects/naxodev/apnea-toy`  
**Protocol:** paper only (no extension tools)  
**Orchestrator:** human + this agent driving Herdr  
**Profiles:** `claude-fable` oneshot planner/reviewer; `pi-grok` interactive coder  

## Checklist

| # | Path | Result |
|---|------|--------|
| 1 | Happy path (2 phases + pr-description) | **PASS** |
| 2 | Plan CHANGES_REQUIRED + rework | **PASS** |
| 3 | Code CHANGES_REQUIRED + live coder rework | **PASS** |
| 4 | APPROVED with `nits` still commits | **PASS** |
| 5 | Kill-and-resume mid-phase | **PASS** |
| 6 | Mixed harness (Claude + Pi) | **PASS** |

## What worked

- Artifact front-matter as sole machine channel — no marker parsing needed.
- Claude oneshot via **stdin task file** (argv + markdown `**` breaks `--allowedTools`).
- Live Pi coder rework on same pane after code CHANGES_REQUIRED.
- Kill pane mid-flight → label respawn → same-round re-dispatch with partial tree work.
- jj `describe` + `new` per phase; bookmark `apnea/greet-cli` at terminus.
- Reviewer found a real symlink/`isMain` bug — gate quality signal, not theater.

## Friction to encode in tools later

1. **Oneshot prompt delivery:** always file→stdin (or equivalent); never paste markdown into fragile argv.
2. **Clear-before-wait:** false “done” if you match old plan content without mtime/path rules — tools must clear target path or use new round paths only.
3. **Herdr `pane run` + shell quoting:** wrapper scripts per dispatch beat inline prompts.
4. **Cold planner pane is a shell**, not an “agent” after `-p` exits (`agent_status: unknown`) — wait on **artifact**, not agent idle alone.
5. **Partial work after kill** is fine; resume must not auto-dispatch without human/reconcile (we re-dispatched same round intentionally).

## Gate decision

**PASSED.** Extension tools for `@naxodev/apnea` may now be implemented against the locked protocol.

## Artifact trail (toy)

```text
.apnea/artifacts/plan.md
.apnea/artifacts/plan-review/round-1.md   # CHANGES_REQUIRED
.apnea/artifacts/plan-review/round-2.md   # APPROVED + nits
.apnea/artifacts/phase-01/round-1/{phase-package,coder-result,code-review}.md
.apnea/artifacts/phase-01/round-2/{coder-result,code-review,verify.log}.md
.apnea/artifacts/phase-02/round-1/{phase-package,coder-result,code-review,verify.log}.md
.apnea/artifacts/pr-description.md
```
