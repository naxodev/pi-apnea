#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${APNEA_TASK_SCRIPT:-}" ]]; then
	echo "apnea: APNEA_TASK_SCRIPT not set (open this pane via apnea dispatch)" >&2
	exit 64
fi
exec bash "$APNEA_TASK_SCRIPT"
