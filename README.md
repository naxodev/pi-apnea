# @naxodev/apnea

Multi-role development workflow for [Pi](https://github.com/earendil-works/pi) inside [Herdr](https://herdr.dev) panes.

File-backed handoffs. Real terminals. No hidden subagents.

> **Status:** paper protocol **passed** (`examples/toy/GATE-RESULTS.md`). Extension tools are implemented under `extension/`. Install/link the package, then drive runs with an orchestrator Pi inside Herdr.

## What it is

A sequential loop:

```text
plan → plan review → phase package → code → code review → verify+commit → …
→ pr-description
```

Roles can be different harnesses (Pi, Claude, Codex, …) via **global profiles**. Project config only rebinds roles to profile names.

## Docs

| Doc | Purpose |
|-----|---------|
| [`CONTEXT.md`](CONTEXT.md) | Glossary |
| [`docs/protocol/overview.md`](docs/protocol/overview.md) | Loop, steps, tools |
| [`docs/protocol/artifacts.md`](docs/protocol/artifacts.md) | Paths + front-matter |
| [`docs/protocol/config.md`](docs/protocol/config.md) | Profiles + trust model |
| [`docs/protocol/manual-gate.md`](docs/protocol/manual-gate.md) | Bootstrap acceptance |
| [`docs/adr/`](docs/adr/) | Decisions |
| [`briefs/`](briefs/) | Role briefs |

## Install

```bash
# local path while developing
pi install /Users/nachovazquez/work/1-projects/naxodev/pi-apnea

# or later
pi install git:github.com/<you>/pi-apnea
```

Requires `~/.config/apnea/config.json` profiles (see `docs/protocol/config.md` or `/apnea-init`).

### Commands (you type these — `/` autocomplete)

| Command | Purpose |
|---------|---------|
| `/apnea setup [--project] [--force]` | global profiles (+ optional project bindings) |
| `/apnea start <goal>` | start a run |
| `/apnea resume` / `abandon` | resume or abandon |
| `/apnea status` | read-only snapshot |
| `/apnea dispatch <kind> [--rework]` | launch a role |
| `/apnea wait` | wait for artifact |
| `/apnea commit [--done] [msg]` | verify + commit phase |
| `/apnea reset-rounds <gate>` | **human only** |
| `/apnea-start` / `/apnea-status` | short aliases |

### Tools (model-facing names)

Same operations as `workflow_start`, `dispatch_role`, `workflow_wait`, `workflow_commit_phase`, `workflow_status`, `workflow_reset_rounds`.

Orchestrator allowlist: all tools **except** `workflow_reset_rounds`, plus `read`.

## Setup

```text
/apnea setup              # ~/.config/apnea/config.json from PATH (+ herdr apnea plugin when herdr is present)
/apnea setup --project    # also .apnea/config.json role→profile only
```

`pane_style` (`regular` default, `floating` opt-in) lives in config; floating needs herdr ≥ 0.7.4 + the linked plugin — see [`docs/protocol/config.md`](docs/protocol/config.md).

Pi **coder** panes launch with a dedicated `PI_CODING_AGENT_DIR` that drops `pi-vimmode` (modal vim traps herdr prompt paste). Your personal orchestrator pi keeps vim; only Apnea-launched role panes are no-vim.

Fallback: skill `apnea-setup` or prompt `/apnea-init` (both point at the same rules). **No config UI in v1.**

## Non-goals (v1)

Worktrees, parallel coders, push/PR automation, memory store, native CLAUDE.md injection, force-approve, config UI.
