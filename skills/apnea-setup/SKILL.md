---
name: apnea-setup
description: Create global Apnea profiles and optional project role bindings. Prefer /apnea setup when the extension is loaded. Use this skill when installing Apnea without commands, switching providers, or fixing config trust errors.
---

# apnea-setup

## Prefer

If the Apnea extension is loaded:

```
/apnea setup
/apnea setup --project   # also write .apnea/config.json bindings
/apnea setup --force     # replace global profiles instead of merge
```

That path is deterministic (no LLM). Use this skill only as a fallback.

## Goal

Leave the user with a valid **global** profile config and optional **project** role bindings. Never put binaries in project config.

## Steps (fallback)

1. Read package `docs/protocol/config.md` if available.
2. Check PATH for: `pi`, `claude`, `codex`, `herdr`, `jj`, `git`.
3. Ensure `~/.config/apnea/` exists.
4. Write or merge `~/.config/apnea/config.json`:
   - Define profiles only for binaries that exist.
   - Include both `cmd_oneshot` and `cmd_interactive` where the harness supports them.
   - Bind default roles: orchestrator+coder → pi profile; planner+reviewer → claude or codex if present, else pi.
5. Optionally write `.apnea/config.json` with **only** `{ "roles": { "...": { "profile": "..." } } }`.
6. Validate against trust rules: no project `cmd_*`, no unknown isolation modes.
7. Next: `/apnea start <goal>` inside Herdr.

## Refuse

- Writing `cmd`, `cmd_oneshot`, `cmd_interactive`, or `bin` under the project.
