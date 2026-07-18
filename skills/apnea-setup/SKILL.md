---
name: apnea-setup
description: Create global Apnea profiles and optional project role bindings. Use when installing Apnea, switching providers, or fixing config trust errors.
---

# apnea-setup

## Goal

Leave the user with a valid **global** profile config and optional **project** role bindings. Never put binaries in project config.

## Steps

1. Read package `docs/protocol/config.md` if available.
2. Check PATH for: `pi`, `claude`, `codex`, `herdr`, `jj`, `git`.
3. Ensure `~/.config/apnea/` exists.
4. Write or merge `~/.config/apnea/config.json`:
   - Define profiles only for binaries that exist.
   - Include both `cmd_oneshot` and `cmd_interactive` where the harness supports them.
   - Bind default roles: orchestrator+coder → pi profile; planner+reviewer → claude or codex if present, else pi.
5. Optionally write `.apnea/config.json` with **only** `{ "roles": { "...": { "profile": "..." } } }`.
6. Validate mentally against trust rules: no project `cmd_*`, no unknown isolation modes.
7. Print next step: run manual gate (`docs/protocol/manual-gate.md`) before expecting tools.

## Refuse

- Writing `cmd`, `cmd_oneshot`, `cmd_interactive`, or `bin` under the project.
- Claiming the workflow is “ready” if extension tools are not implemented yet.
