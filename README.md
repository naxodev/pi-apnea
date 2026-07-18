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

### Tools

| Tool | Purpose |
|------|---------|
| `workflow_start` | start / resume / abandon |
| `dispatch_role` | task file + Herdr launch |
| `workflow_wait` | artifact front-matter |
| `workflow_commit_phase` | APPROVED + verify + jj/git |
| `workflow_status` | read-only |
| `workflow_reset_rounds` | **human only** |

Orchestrator allowlist: all of the above **except** `workflow_reset_rounds`, plus `read`.

## Setup (planned)

```text
/apnea-init
# or skill: apnea-setup
```

Writes `~/.config/apnea/config.json` profiles and optional project role bindings. **No config UI in v1.**

## Non-goals (v1)

Worktrees, parallel coders, push/PR automation, memory store, native CLAUDE.md injection, force-approve, config UI.
