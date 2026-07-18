# Orchestrator authority: tools are the state machine

The loop is deterministic; the default orchestrator model is not. Every mutating tool validates `state.json.step` and refuses illegal transitions with a corrective error. The orchestrator Pi allowlist is Apnea tools + `read` only. `workflow_status` is read-only. Cap reset is a separate human-only tool (`workflow_reset_rounds`) so the orchestrator cannot lift its own rework guardrail. Hand-editing `state.json` voids the warranty.
