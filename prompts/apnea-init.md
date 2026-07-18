---
description: Initialize Apnea config (prefer /apnea setup)
---

Prefer the slash command (no model needed):

```
/apnea setup
/apnea setup --project
```

If tools/commands are unavailable, run the apnea-setup skill steps:

1. Detect `pi`, `claude`, `codex`, `herdr`, `jj`, `git` on PATH.
2. Create or update `~/.config/apnea/config.json` with **profiles** only (no project cmds).
3. Optional: `.apnea/config.json` with role→profile names only.
4. Point at `docs/protocol/config.md`.

Do not invent binaries. Do not write `cmd` into project config.
