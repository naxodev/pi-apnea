# Manual gate (before any extension code)

## Goal

Prove the paper protocol works with mixed harnesses and file handoffs **without** Apnea tools. Human acts as orchestrator.

## Setup

- Herdr session in a throwaway toy repo (jj or git)
- Global profiles already defined (hand-written or future `/apnea-init`)
- Briefs from this package mounted or copied read-only for agents to read
- Layout under `.apnea/` created by hand as needed

## Toy feature

Two phases, e.g. “CLI that greets by name + `--json` flag,” small enough to finish in one sitting.

## Required paths (must all pass)

| # | Path | Pass criteria |
|---|------|----------------|
| 1 | Happy path | Two phases committed/described; `pr-description.md` exists |
| 2 | Plan CHANGES_REQUIRED | At least one plan rework; new plan-review round artifact; **no** manual verdict transcription |
| 3 | Code CHANGES_REQUIRED | Live follow-up into existing coder pane; new `round-N` code-review; then APPROVED |
| 4 | APPROVED + nits | One review with `nits` field; commit still proceeds |
| 5 | Kill-and-resume | Kill coder pane mid-phase; human reconciles per protocol (artifact present? ingest : re-dispatch same round); continue to success |
| 6 | Mixed harness | Planner/reviewer Claude oneshot; coder Pi interactive |

## Hard rules during the gate

- Every verdict read from artifact front-matter only  
- No tool code, no “helper scripts” that parse markers as truth  
- Verify commands run by the human-orchestrator before each phase “commit” (simulating `workflow_commit_phase`)  
- Reviewer must not leave a dirty file-content tree; if they do, treat as escalate  

## Exit

When the table passes, record a short note in `examples/toy/GATE-RESULTS.md` and only then implement extension tools.
