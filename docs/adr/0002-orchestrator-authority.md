# Orchestrator authority: tools are the state machine

The loop is deterministic; the default orchestrator model is not. Every mutating tool validates `state.json.step` and refuses illegal transitions with a corrective error. `workflow_status` is read-only. Cap reset is not a model-facing tool at all: `reset-rounds` exists only on the CLI and as `/apnea reset-rounds`, and the CLI refuses it unless stdin/stdout are a terminal and the human retypes the gate key. `--i-am-human` overrides for scripts — the guarantee is auditability, not prevention. Hand-editing `state.json` voids the warranty.
