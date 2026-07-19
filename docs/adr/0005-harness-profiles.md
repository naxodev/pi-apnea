# Harness abstraction: profiles with mode variants

Roles do not carry freeform model strings. Global **profiles** define `cmd_interactive` (required for dispatch) and optional `cmd_oneshot` (unused by Apnea dispatch). Every worker role opens the interactive harness TUI in a labeled Herdr pane so humans can watch the session; dispatch never uses print/oneshot flags. Binding a role to a profile missing `cmd_interactive` hard-errors at start. Project config may only rebind role→profile names.
