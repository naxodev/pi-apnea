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
  // "regular" (default) or "floating"; omit the key to keep the default
  "pane_style": "regular",
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

## Role timeout vs. `--timeout`

`timeouts_ms` above sets each role's real deadline. `dispatch_role` (`apnea dispatch`) reads it
and stamps the deadline into `state.json` at dispatch time, so it survives across process
restarts and repeated `wait` calls.

`apnea wait --timeout=<ms>` and `/apnea wait --timeout=<ms>` are a different knob: `--timeout`
is an alias for `--budget`, and both bound how long **that one call** blocks before returning —
not the role's deadline. There is a 120000ms floor. When the call's budget runs out before the
role's deadline, it exits `3` ("still waiting") and the caller must call `wait` again; this does
not extend or shorten the role's timeout.

## Pane style

`pane_style` controls how role dispatches appear in Herdr:

- Values: `"regular"` | `"floating"`. Default is `"regular"` — **omitting the key changes nothing**.
- Allowed in global config and overridable per project.
- `"floating"` applies to **planner/reviewer oneshot dispatches only**. It requires herdr ≥ 0.7.4 **and** the linked `apnea` plugin (provisioned by `/apnea setup`). The popup is **session-modal**: it takes keyboard input until the worker exits, and dismissing it early kills the dispatch.
- Floating oneshot scripts resolve `cmd_oneshot[0]` to an **absolute path** in the orchestrator environment and pass an augmented `PATH` into the popup. Bare names must be findable via the orchestrator's `PATH` (e.g. `~/.local/bin`); otherwise dispatch fails immediately instead of the popup exiting 127. Prefer absolute `cmd_oneshot` if your orchestrator process has a stripped PATH.
- **Lifecycle (single popup):** herdr allows only one popup. Dispatch refuses while a prior floating oneshot is still live. The worker writes an exit-status file; `workflow_wait` fails closed when the popup dies without a complete artifact (instead of hanging until timeout). A second open while a popup is up surfaces `popup already open` immediately.
- Interactive roles (orchestrator, coder) always use regular panes; the dispatch result reports `pane_style_effective: "regular (interactive role)"`.
- Misconfiguration (old herdr, missing plugin, missing `cmd_oneshot`, unresolved oneshot binary) fails fast at dispatch with an actionable error.
- Non-goal: per-role `pane_style` is future work. Setup never writes or flips this key — it only preserves a valid existing value on re-run.

## Role modes (fixed)

By default every worker role launches the **interactive** harness TUI so you can watch it in Herdr. With `pane_style: "floating"`, planner and reviewer instead run their profile's **`cmd_oneshot`** inside the popup (those profiles therefore need `cmd_oneshot` for floating — dispatch preflight errors otherwise). Interactive roles always stay on `cmd_interactive`.

| Role | Required profile capability |
|------|-----------------------------|
| orchestrator | `cmd_interactive` |
| planner | `cmd_interactive` (and `cmd_oneshot` when `pane_style: "floating"`) |
| reviewer | `cmd_interactive` (and `cmd_oneshot` when `pane_style: "floating"`) |
| coder | `cmd_interactive` |

Binding a role to a profile missing the required capability → **hard-error**.

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
