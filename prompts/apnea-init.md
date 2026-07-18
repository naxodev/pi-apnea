---
description: Initialize Apnea global profiles and optional project role bindings
---

Run the apnea-setup skill.

1. Detect `pi`, `claude`, `codex`, `herdr`, `jj`, `git` on PATH.
2. Create or update `~/.config/apnea/config.json` with safe default **profiles** only (no project cmds).
3. If the user wants project bindings, write `.apnea/config.json` with role→profile names only.
4. Remind them: paper protocol / manual gate must pass before extension tools exist.
5. Point at package docs: `docs/protocol/config.md` and `docs/protocol/manual-gate.md`.

Do not invent binaries. Do not write `cmd` into project config.
