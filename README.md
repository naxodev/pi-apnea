# @naxodev/apnea

Multi-role development workflow for [Pi](https://github.com/earendil-works/pi) inside [Herdr](https://herdr.dev) panes.

File-backed handoffs. Real terminals. No hidden subagents.

> **Status:** paper protocol **passed** (`examples/toy/GATE-RESULTS.md`). Extension tools are implemented under `extension/`. Install/link the package, then drive runs with an orchestrator Pi inside Herdr.

The extension internals are written with Effect v4 — services/layers for IO, Schema for state/config, tagged errors instead of throw-based control flow (see [ADR 0008](docs/adr/0008-effect-v4-internals.md)).

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
| `/apnea setup [--project] [--force] [--agents-md]` | global profiles (+ optional project bindings, `AGENTS.md` primer) |
| `/apnea start <goal>` | start a run |
| `/apnea resume` / `abandon` | resume or abandon |
| `/apnea status` | read-only snapshot |
| `/apnea dispatch <kind> [--rework]` | launch a role |
| `/apnea wait` | wait for artifact |
| `/apnea commit [--done] [msg]` | verify + commit phase |
| `/apnea reset-rounds <gate>` | **human only** |
| `/apnea-start` / `/apnea-status` | short aliases |

### Tools (model-facing names)

Same operations as `workflow_start`, `dispatch_role`, `workflow_wait`, `workflow_commit_phase`, `workflow_status`, plus `read`.

`reset-rounds` is not a Pi tool. It exists only as `apnea reset-rounds` (CLI) and `/apnea reset-rounds` (slash command). Only the CLI gates it — it refuses unless stdin/stdout are a terminal and a human retypes the gate key (or passes `--i-am-human`). The slash command has no such gate: `/apnea` is already a human at a terminal. See [ADR 0002](docs/adr/0002-orchestrator-authority.md).

### CLI (`apnea`, no Pi required)

Any harness that can run a shell command can hold the orchestrator seat — the CLI and the Pi
tools share one definition in `extension/registry.ts`, so they can't drift apart (see
[ADR 0009](docs/adr/0009-cli-driver-split.md)).

`npm publish` needs `@naxodev/apnea` to lose its `"private": true` flag first, so
`bun install -g @naxodev/apnea` does not work yet. Build from a checkout instead:

```bash
cd pi-apnea   # your checkout of this repo
bun install
bun run build
./dist/cli.js help
```

Optionally put it on `PATH`, e.g. `ln -s "$(pwd)/dist/cli.js" ~/.local/bin/apnea`.

| Verb | Purpose |
|------|---------|
| `apnea setup [--project] [--force] [--agents-md]` | global profiles (+ optional project bindings, `AGENTS.md` primer) |
| `apnea start <goal> [--allow-dirty] [--slug=name]` | start a run |
| `apnea resume` / `apnea abandon` | resume or abandon |
| `apnea status` | read-only snapshot |
| `apnea dispatch <kind> [--rework]` | launch a role |
| `apnea wait [--poll=<ms>] [--budget=<ms>]` | wait for the pending artifact |
| `apnea commit [--done] [message]` | verify + commit phase |
| `apnea reset-rounds <gate> [--i-am-human]` | human only |

`apnea wait` is resumable: exit `3` means the call's budget ran out but the role hasn't timed
out, so call `apnea wait` again. Exit codes: `0` ok, `1` refused/error, `2` usage, `3` still
waiting.

`--timeout` is an alias for `--budget` on `apnea wait`. Both bound how long **this call**
blocks (120s floor), not the role's deadline — the role timeout comes from `timeouts_ms` in
config and is stamped at dispatch. See [`docs/protocol/config.md`](docs/protocol/config.md).

## Setup

```text
/apnea setup              # ~/.config/apnea/config.json from PATH (+ herdr apnea plugin when herdr is present)
/apnea setup --project    # also .apnea/config.json role→profile only
/apnea setup --agents-md  # also write/refresh an AGENTS.md loop primer at the repo root
```

`pane_style` (`regular` default, `floating` opt-in) lives in config; floating needs herdr ≥ 0.7.4 + the linked plugin — see [`docs/protocol/config.md`](docs/protocol/config.md).

Pi **coder** panes launch with a dedicated `PI_CODING_AGENT_DIR` that drops `pi-vimmode` (modal vim traps herdr prompt paste). Your personal orchestrator pi keeps vim; only Apnea-launched role panes are no-vim.

Fallback: skill `apnea-setup` or prompt `/apnea-init` (both point at the same rules). **No config UI in v1.**

## Non-goals (v1)

Worktrees, parallel coders, push/PR automation, memory store, native CLAUDE.md injection, force-approve, config UI.
