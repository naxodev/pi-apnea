# @naxodev/apnea

Multi-role development workflow for [Pi](https://github.com/earendil-works/pi) inside [Herdr](https://herdr.dev) panes.

File-backed handoffs. Real terminals. No hidden subagents.

> **Status:** paper protocol. Extension tools are intentionally not implemented until the manual gate in [`docs/protocol/manual-gate.md`](docs/protocol/manual-gate.md) passes.

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

## Install (later)

```bash
pi install git:github.com/<you>/pi-apnea
```

v1 also targets npm as `@naxodev/apnea` once the package is real.

## Setup (planned)

```text
/apnea-init
# or skill: apnea-setup
```

Writes `~/.config/apnea/config.json` profiles and optional project role bindings. **No config UI in v1.**

## Non-goals (v1)

Worktrees, parallel coders, push/PR automation, memory store, native CLAUDE.md injection, force-approve, config UI.
