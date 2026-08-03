# @naxodev/apnea

Apnea drives a multi-role development loop — plan, review, code, review, verify, commit — where
each role runs in its own real terminal pane and hands off work through files on disk instead of
a hidden subagent. Any harness that can run a shell command can hold the orchestrator seat.

## The loop

```text
plan → plan review → phase package → code → code review → verify+commit → …
→ pr-description
```

Roles can be different harnesses (Pi, Claude, Codex, …) via **global profiles**. Project config
only rebinds roles to profile names that already exist.

## Requirements

- **bun `>=1.3.7`.** Needed to **run** the tool, not just to build it: the installed `bin` is
  `dist/cli.js` with a `#!/usr/bin/env bun` shebang, and npm does not enforce the `engines.bun`
  key. If you install `@naxodev/apnea` globally with only `node` on `PATH`, the `apnea` command
  will fail on first invocation — this is the most likely first-run failure for a new user.
- **herdr**, for pane-based dispatch. The optional `floating` pane style additionally needs
  **herdr ≥ 0.7.4** plus the linked plugin (see [`docs/protocol/config.md`](docs/protocol/config.md)).
- **jj or git.** Per [ADR 0007](docs/adr/0007-jj-first-commits.md), if neither is present
  auto-commit is refused.
- **At least one agent CLI** — `pi`, `claude`, or `codex`.

## Install

```bash
bun install -g @naxodev/apnea
# or
npm install -g @naxodev/apnea
```

> `0.1.0` has not been published to the npm registry yet. Until it is, install from source (below).

As a Pi extension:

```bash
pi install git:github.com/naxodev/pi-apnea
```

From source, for contributors:

```bash
cd pi-apnea   # your checkout of this repo
bun install
bun run build
./dist/cli.js help
```

Optionally put it on `PATH`, e.g. `ln -s "$(pwd)/dist/cli.js" ~/.local/bin/apnea`.

## Sixty-second quickstart

1. `apnea setup` — writes global profiles to `~/.config/apnea/config.json` (and the herdr
   `apnea` plugin, if herdr is present).
2. `apnea start "<goal>"` — starts a run against your working copy.
3. `apnea status` — a read-only snapshot of where the run stands and what to call next.

`apnea status` with no run in progress looks like this:

```console
$ apnea status
OK: no active run
next: apnea start
{
  "has_state": false
}
```

## CLI reference

Any harness that can run a shell command can hold the orchestrator seat — the CLI and the Pi
tools share one definition in `extension/registry.ts`, so they can't drift apart (see
[ADR 0009](docs/adr/0009-cli-driver-split.md)).

### Commands (you type these — `/` autocomplete, inside Pi)

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

Same operations as `workflow_start`, `dispatch_role`, `workflow_wait`, `workflow_commit_phase`,
`workflow_status`, plus `read`.

`reset-rounds` is not a Pi tool. It exists only as `apnea reset-rounds` (CLI) and
`/apnea reset-rounds` (slash command). Only the CLI gates it — it refuses unless stdin/stdout are
a terminal and a human retypes the gate key (or passes `--i-am-human`). The slash command has no
such gate: `/apnea` is already a human at a terminal. See
[ADR 0002](docs/adr/0002-orchestrator-authority.md).

### CLI (`apnea`, no Pi required)

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
waiting. See [`docs/protocol/config.md`](docs/protocol/config.md) for the budget-floor
arithmetic behind `--poll` and `--budget`.

### Setup flags

```text
/apnea setup              # ~/.config/apnea/config.json from PATH (+ herdr apnea plugin when herdr is present)
/apnea setup --project    # also .apnea/config.json role→profile only
/apnea setup --agents-md  # also write/refresh an AGENTS.md loop primer at the repo root
```

`pane_style` (`regular` default, `floating` opt-in) lives in config; floating needs herdr ≥ 0.7.4
+ the linked plugin — see [`docs/protocol/config.md`](docs/protocol/config.md).

Pi **coder** panes launch with a dedicated `PI_CODING_AGENT_DIR` that drops `pi-vimmode` (modal
vim traps herdr prompt paste). Your personal orchestrator pi keeps vim; only Apnea-launched role
panes are no-vim.

Fallback: skill `apnea-setup` or prompt `/apnea-init` (both point at the same rules). **No config
UI in v1.**

## Maturity status

**What you can rely on:** the loop, the artifact contract, and the CLI are implemented, and the
extension suite is green — CI runs it on every pull request.

**What may still change:** the command surface and config shape may move before `1.0`. This is
`0.1.0` — breaking changes will land in minor bumps, not patches.

**Non-goals for v1:** worktrees, parallel coders, push/PR automation, memory store, native
CLAUDE.md injection, force-approve, config UI.

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

## Contributing

Build, test, typecheck commands, version-control conventions, and what CI enforces are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Apnea runs repo-controlled text through agent CLIs by design — read
[`SECURITY.md`](SECURITY.md) for the trust model before pointing it at a repository you don't
trust, and for how to report a vulnerability.

## License

MIT — see [`LICENSE`](LICENSE).
