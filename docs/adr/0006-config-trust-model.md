# Config trust: binaries only in global config

Project-local argv is RCE on `workflow_start`. Profiles and all `cmd_*` arrays resolve only from `~/.config/apnea/config.json` (plus package defaults). `.apnea/config.json` may rebind roles to existing profile names and set caps/timeouts. Unknown keys and unimplemented values hard-error. Repo text (tasks, plans, verify commands) remains an accepted prompt-injection surface and is disclosed, not denied.
