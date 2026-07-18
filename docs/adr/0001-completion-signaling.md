# Completion signaling: artifact front-matter only

A sequential loop has at most one outstanding dispatch. Multiple completion channels (result JSON, pane markers, agent-status parsing) create competing parsers and fail open on the weakest one. We use a single machine channel: the role writes one artifact with YAML front-matter (`status`, optional `verdict`/`nits`). Markers are human-only; Herdr agent-status is liveness only. Absence of the target path (clear-before-dispatch / per-round paths) replaces dispatch-id correlation.
