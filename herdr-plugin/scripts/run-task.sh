#!/bin/bash
set -euo pipefail
if [[ -z "${APNEA_TASK_SCRIPT:-}" ]]; then
	echo "apnea: APNEA_TASK_SCRIPT not set (open this pane via apnea dispatch)" >&2
	exit 64
fi
# Absolute bash: popup PATH may not resolve bare `bash` (exit 127).
exec /bin/bash "$APNEA_TASK_SCRIPT"
