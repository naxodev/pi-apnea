# Apnea

A Pi package that runs a multi-role development workflow inside Herdr panes, using file-backed handoffs instead of hidden subagents.

## Language

**Run**:
One user goal executed end-to-end until a PR description artifact exists.
_Avoid_: Session, job, workflow instance

**Phase**:
A planner-owned vertical slice of the goal with acceptance checks and verify commands.
_Avoid_: Step, ticket, task (when meaning the slice)

**Phase package**:
The written contract that bounds one phase for the coder (files, steps, checks, non-goals).
_Avoid_: Spec, ticket body, prompt

**Dispatch**:
One assignment of work to a single role for a single gate.
_Avoid_: Subagent call, tool call, spawn

**Round**:
One rework iteration on a (phase, gate) after CHANGES_REQUIRED.
_Avoid_: Retry, attempt (unless crash/timeout)

**Verdict**:
The reviewer's binary decision: APPROVED or CHANGES_REQUIRED.
_Avoid_: Status, result (use those for dispatch completion)

**Nits**:
Optional non-blocking notes attached to an APPROVED verdict.
_Avoid_: Soft fail, approved with changes

**Brief**:
Package-owned role identity document (harness-agnostic).
_Avoid_: System prompt, agent md (when meaning the shared contract)

**Artifact**:
A role's required output file for a dispatch, with machine-readable front-matter.
_Avoid_: Log, transcript, marker

**Gate**:
A tool-enforced precondition (step legality, verdict, verify commands, dirty-tree).
_Avoid_: Check, hook

**Profile**:
A globally defined harness launch template declaring oneshot and/or interactive commands.
_Avoid_: Model, provider, harness (when meaning the named config entry)

**Role**:
A fixed part in the loop (orchestrator, planner, reviewer, coder) with a fixed interaction mode.
_Avoid_: Agent, subagent

**Orchestrator**:
The hybrid scheduler that drives tools and never implements product code.
_Avoid_: Parent agent, main agent

**Verify command**:
A shell command from the phase package that must exit zero before commit.
_Avoid_: Test (when meaning the gate command list)
