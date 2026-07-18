# Verify commands run at commit, not by trust

Phase packages include verify commands, but a readonly-in-spirit reviewer cannot be the hard gate. `workflow_commit_phase` executes those commands, writes `artifacts/phase-N/round-M/verify.log`, and refuses on non-zero exit in addition to requiring APPROVED. Planner-authored commands are arbitrary code in the project cwd — accepted as the same trust domain as the coder writing sources. Plan review must sanity-read verify commands before approving a plan. No sandbox in v1.
