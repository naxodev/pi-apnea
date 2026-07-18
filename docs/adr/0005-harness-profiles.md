# Harness abstraction: profiles with mode variants

Roles do not carry freeform model strings. Global **profiles** define `cmd_oneshot` and/or `cmd_interactive`. Each role has a fixed mode (planner/reviewer oneshot; coder interactive; orchestrator interactive). Binding a role to a profile missing the required variant hard-errors at start. Cold roles run as oneshot processes inside a labeled Herdr pane for observability; interactive roles keep a live TUI. Project config may only rebind role→profile names.
