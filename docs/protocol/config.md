# Config

## Layers (merge order)

1. Package defaults  
2. `~/.config/apnea/config.json` — **only place profiles/`cmd` may appear**  
3. `.apnea/config.json` — role → profile bindings, caps, timeouts, slug defaults  
4. Per-run `workflow_start` args — slug, allow-dirty, temporary role rebinds  

Unknown keys and unimplemented values (`isolation: "worktree"`) **hard-error** at start.

## Global profiles

```jsonc
// ~/.config/apnea/config.json
{
  "profiles": {
    "pi-grok": {
      "cmd_interactive": ["pi", "--provider", "grok-cli", "--model", "grok-4.5"],
      "cmd_oneshot": ["pi", "--print", "--provider", "grok-cli", "--model", "grok-4.5"]
    },
    "claude-fable": {
      // oneshot needs Write (or equivalent) so the role can emit artifacts
      "cmd_oneshot": [
        "claude", "-p", "--model", "claude-fable-5",
        "--allowedTools", "Read,Write,Edit,Glob,Grep"
      ],
      "cmd_interactive": ["claude", "--model", "claude-fable-5"]
    }
  },
  "roles": {
    "orchestrator": { "profile": "pi-grok" },
    "planner": { "profile": "claude-fable" },
    "reviewer": { "profile": "claude-fable" },
    "coder": { "profile": "pi-grok" }
  },
  "review_round_cap": 3,
  "timeouts_ms": {
    "planning": 1500000,
    "plan_review": 900000,
    "phase_packaging": 900000,
    "coding": 2700000,
    "code_review": 900000,
    "verify": 900000
  }
}
```

## Role modes (fixed)

Every worker role launches the **interactive** harness TUI so you can watch it in Herdr. `cmd_oneshot` may still exist in a profile for other tools, but Apnea dispatch does not use it.

| Role | Required profile capability |
|------|-----------------------------|
| orchestrator | `cmd_interactive` |
| planner | `cmd_interactive` |
| reviewer | `cmd_interactive` |
| coder | `cmd_interactive` |

Binding a role to a profile missing `cmd_interactive` → **hard-error**.

## Project config (no binaries)

```jsonc
// .apnea/config.json
{
  "roles": {
    "coder": { "profile": "pi-grok" }
  },
  "review_round_cap": 3
}
```

Project entries that include `cmd`, `cmd_oneshot`, `cmd_interactive`, or `bin` → **hard-error**.

## Trust model

- Repo-controlled **text** (tasks, plans, verify commands, briefs if vendored) is an accepted prompt-injection surface — disclosed, not “solved.”
- Repo-controlled **argv** is not allowed.
- Planner-authored verify commands run at commit gate in the project cwd (same trust domain as the coder writing source). Output → `verify.log`.

## Setup skill

`apnea-setup` / `/apnea-init`:

- Detect available binaries (`pi`, `claude`, `codex`, `herdr`, `jj`, `git`)
- Write a safe global starter config
- Optionally write project role bindings
- Never write `cmd` into project config
- Point at the manual gate before claiming readiness
