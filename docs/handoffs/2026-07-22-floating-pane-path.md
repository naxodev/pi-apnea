# Handoff: floating planner/reviewer panes exit 127 (PATH)

**Date:** 2026-07-22  
**Severity:** high (floating mode unusable for any binary not on herdr server bare PATH)  
**Repo:** `pi-apnea`  
**Status:** fixed in working tree — `writeFloatingTaskScript` embeds absolute binary + `openFloatingPane` passes augmented `PATH`; missing binary fails closed at dispatch  
**Workaround (pre-fix):** `~/.config/apnea/config.json` → `"pane_style": "regular"`

## Symptom

With `pane_style: "floating"`, `dispatch_role` for planner/reviewer reports success and opens the apnea herdr plugin popup, but:

1. The popup vanishes almost immediately (or is invisible if focus moves).
2. No artifact is written (e.g. `.apnea/artifacts/plan.md`).
3. `workflow_wait` times out with `pending_pane_id: null` (by design for floating).
4. herdr server log shows:

```text
plugin.pane.open → pane.spawned → pane.exit status="ExitStatus { code: 127 }"
```

Exit **127** = command not found.

Reproduced on lumberjack run  
`slug=i-want-to-migrate-our-docs-from-docusaurus-to-as`  
herdr **0.7.4**, apnea plugin linked, macOS.

## Root cause

Floating dispatch path (`extension/lib/herdr.ts`):

1. `writeFloatingTaskScript` writes a oneshot bash script:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cd <project-root>
   exec claude -p --model … '<prompt>'
   ```

2. `openFloatingPane` opens the plugin worker with only:

   ```text
   APNEA_TASK_SCRIPT=<abs path to that .sh>
   ```

3. Plugin `herdr-plugin/scripts/run-task.sh` does `exec bash "$APNEA_TASK_SCRIPT"`.

4. The task script’s bare `claude` (or `pi`, etc.) is resolved against the **herdr plugin pane environment**, not the user’s interactive shell.

Observed: plugin popup PATH does **not** include `~/.local/bin` (where `claude` lives: `/Users/nachovazquez/.local/bin/claude`). Interactive/regular panes work because they inherit a real login/interactive shell PATH.

Secondary footgun (docs already warn): floating is **session-modal**. Focus change / dismiss sends Hangup and kills the worker mid-run — even when PATH is fine. Orchestrator then has no `pending_pane_id` to recover against.

## Evidence trail

| Check | Result |
|-------|--------|
| `herdr plugin list` | `apnea` enabled, local link OK |
| `supportsFloating` / herdr version | 0.7.4 OK |
| Manual `herdr plugin pane open --plugin apnea … --env APNEA_TASK_SCRIPT=…` | spawn OK, exit **127** in ~10ms |
| `which claude` in user shell | `~/.local/bin/claude` |
| Bare/minimal PATH | `claude` missing |
| Regular interactive dispatch | not used while `pane_style=floating`; should work after workaround |

Relevant code:

- `extension/tools/dispatch.ts` — floating branch (~300–340): oneshot + `openFloatingPane`, clears `pending_pane_id`
- `extension/lib/herdr.ts` — `writeFloatingTaskScript`, `openFloatingPane`
- `herdr-plugin/scripts/run-task.sh` — forwards to `APNEA_TASK_SCRIPT`
- `docs/protocol/config.md` — floating = oneshot + session-modal popup

## Desired fix (pick one or combine)

### A. Resolve binaries at script-write time (recommended)

In `writeFloatingTaskScript`, resolve the first argv of `cmd` via `which`/absolute path **in the orchestrator process environment** (the process that already found the harness), and write the absolute path into the script:

```bash
exec /Users/…/.local/bin/claude -p …
```

Pros: no herdr server restart; works for user-local installs.  
Cons: still fails if orchestrator PATH itself is wrong; does not fix PATH for child tools the oneshot agent spawns.

### B. Inject a known-good PATH into the popup

`openFloatingPane` should pass `--env PATH=…` composed from:

- current process `PATH`, and/or
- explicit extras: `~/.local/bin`, homebrew prefixes, `~/.bun/bin`, etc.

Pros: child tools of the oneshot agent also resolve.  
Cons: must stay in sync with how users install CLIs; careful not to drop system paths.

### C. Fail closed with a preflight

Before opening the popup, `resolveRoleCmd` + `fs.access`/`which` the binary; if missing on a PATH that mirrors the popup, return an actionable dispatch error:

```text
floating oneshot binary "claude" not found on popup PATH; use absolute cmd_oneshot or pane_style=regular
```

Do this even if A/B land — silent exit 127 is the worst failure mode.

### D. Surface popup failure to wait/dispatch

Today exit 127 is invisible to Apnea state (no pane id, no exit status capture). Capture plugin pane failure or at least detect “script exited before artifact with non-zero” via a wrapper that writes `.apnea/tasks/<id>.exit` / logs stderr to a known path, and have `workflow_wait` report it instead of hanging until timeout.

### E. Docs / setup

- Document that floating oneshot requires binaries on **herdr plugin PATH**, not just interactive shell PATH.
- `/apnea setup` could warn when `cmd_oneshot[0]` is bare and not found under a minimal PATH.
- Optional: recommend absolute paths in profile examples.

## Out of scope / non-goals

- Changing herdr core PATH policy (may still file upstream if plugin panes intentionally get a stripped env).
- Per-role `pane_style` (already noted as future work).
- Replacing oneshot with interactive inside floating (product choice; interactive + floating is unsupported today).

## Acceptance criteria for the fix

1. With `pane_style: "floating"` and a bare `claude`/`pi` on the user’s normal PATH but only under `~/.local/bin`, planner dispatch writes `.apnea/artifacts/plan.md` without manual absolute paths.
2. If the binary truly cannot be resolved, dispatch fails immediately with a message naming the binary and suggesting `pane_style=regular` or an absolute `cmd_oneshot`.
3. Regression test: unit/smoke that `writeFloatingTaskScript` embeds an absolute executable path (or that open env includes PATH containing a fixture bin).
4. Manual: one floating plan dispatch on a machine where `claude` is only in `~/.local/bin`.

## Workaround (already applied for lumberjack run)

```jsonc
// ~/.config/apnea/config.json
"pane_style": "regular"
```

Re-dispatch roles after the change; interactive TUI panes inherit shell PATH and keep `pending_pane_id` for recovery.

## Suggested first commit / PR shape

```text
fix(floating): resolve oneshot binary + fail closed on missing PATH
```

1. Absolute-path rewrite in `writeFloatingTaskScript` (or shared helper).
2. Optional PATH pass-through on `openFloatingPane`.
3. Preflight error path in floating dispatch branch.
4. Test in `extension/lib/herdr.test.ts`.
5. Note in `docs/protocol/config.md` under Pane style.

---

## Related issue found same run: verify commands are line-split

`extractVerifyCommands` → `commandsFromFenceBody` treats **each non-empty line** of the ```sh fence as a separate `bash -lc` invocation (`extension/lib/vcs.ts`).

Multi-line constructs (backslash-continued `for` loops, piped `grep` split across lines) therefore fail at `workflow_commit_phase` with:

```text
bash: -c: line 4: syntax error: unexpected end of file from `for' command
```

### Desired fix
- Join backslash-continued lines before splitting, **or**
- Run the entire fence body as one script, **or**
- Document + planner-brief rule: verify fences must be one command per line (no `\` continuations, no multi-line `for`/`if`).

Workaround used this run: flattened Phase 1 verify block to single-line `for` / `test -z "$(grep …)"` in the phase-package artifact.

---

## Related: stale `grok-cli` provider name kills coder panes

Apnea default profile still uses `--provider grok-cli`, but current pi registers the provider as **`xai`**.

Symptom: `dispatch_role kind=code` creates a pane, `pi` exits immediately with:

```text
Error: Unknown provider "grok-cli". Use --list-models to see available providers/models.
```

`pending_pane_id` points at a dead pane; `workflow_wait` fails with `pane_missing`.

Fix applied locally: `~/.config/apnea/config.json` profiles `pi-grok` → `--provider xai`.

Setup should detect the real provider id from `pi --list-models` rather than hardcoding `grok-cli`.
