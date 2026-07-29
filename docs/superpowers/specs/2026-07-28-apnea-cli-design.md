# Design: `apnea` CLI — a portable orchestrator seat

**Date:** 2026-07-28
**Status:** approved, not yet implemented

## Problem

Apnea's loop is deterministic; its orchestrator model is not. Today that determinism is
enforced by Pi extension tools, which means the orchestrator seat only exists inside Pi.
Worker roles are already harness-generic — [ADR 0005](../../adr/0005-harness-profiles.md)
profiles let the coder be Claude or Codex, and handoffs are files under `.apnea/`, not
agent-to-agent messages. The orchestrator is the last Pi-shaped hole in an otherwise
portable protocol.

The coupling is thin enough to be worth closing. Only `extension/index.ts` (212 lines,
tool registration) and `extension/adapters/commands.ts` (330 lines, slash commands) import
`@earendil-works/pi-coding-agent`. Everything under `workflows/`, `services/`, `domain/`,
and `schema/` — 4,131 of the extension's 5,540 non-test lines — has no Pi import.
`extension/adapters/*.ts` is already a port layer: every one is
`runToolResult(xWorkflow(params, process.cwd()), AppLive)`.

## Goal

Any agent that can run a shell command can drive an Apnea run. Optimize for machine
consumption: parseable output, self-describing next steps, and errors an agent can act on
without a human.

**Non-goals.** Rewriting the state machine. Changing the protocol, artifact layout, or
config format. Removing the Pi plugin. Headless/CI operation — dispatch still assumes a
live Herdr multiplexer.

## Decisions

| Question | Decision |
|---|---|
| Primary consumer | Any agent orchestrates by shelling out |
| Pi plugin fate | Thin shim over a shared registry; keeps its exclusives |
| Structure | Declarative command registry, both drivers generated from it |
| `reset-rounds` gate | TTY + typed confirmation, `--i-am-human` escape hatch |
| Agent onboarding | Self-describing output plus shipped skill/`AGENTS.md` |
| Distribution | npm `bin`, Bun runtime, `bun build --target=bun` |
| Wait model | Bounded and resumable, ~5 min default budget |

## Architecture

One new module, `extension/registry.ts`, is the single definition of every operation:

```ts
type Operation = {
  tool: string | null;       // Pi tool name; null = not model-facing (setup, reset-rounds)
  verb: string;              // CLI verb: "dispatch", "reset-rounds"
  summary: string;           // shared by tool description and --help
  guidance?: string;         // tool-only prose ("after start you MUST…")
  params: TSchema;           // existing Typebox object, moved verbatim from index.ts
  humanOnly?: true;          // gates reset-rounds behind the TTY check
  run: (params, hooks?) => Promise<ToolResult>;   // existing adapters/*
};
```

Three consumers, none of which own definitions:

- **`extension/index.ts`** — filters `tool !== null`, calls `pi.registerTool`. Shrinks from
  212 lines to roughly 30.
- **`extension/adapters/commands.ts`** — keeps `/apnea` and its autocomplete, but derives
  `SUBS` (`commands.ts:18`) and `helpText()` (`commands.ts:80`) from the registry instead of
  the two hand-maintained literals.
- **`extension/cli/`** (new) — `main.ts` (argv → operation → exit code), `parse.ts` (flags),
  `format.ts` (human vs `--json`).

`extension/adapters/*.ts` is unchanged. `workflows/`, `services/`, `domain/`, `schema/` are
untouched except for the state additions below.

`parseFlags` (`commands.ts:66`) already does exactly what the CLI needs. It moves to
`extension/cli/parse.ts`; `commands.ts` imports it. Its tests move with it.

The registry stays a plain array of objects with a hand-written handler per entry. No
codegen, no schema-to-parser magic beyond flat string/boolean/number flags — which is all
the current parameters are.

### Why a registry rather than a second parser

Keeping two drivers means accepting drift risk. A registry removes it structurally: adding a
command or renaming a parameter cannot desync the front-ends because there is only one
definition. It also gives the tool-name → CLI-verb mapping a home, which `legal_next`
rendering requires regardless.

## Command surface

| Tool | CLI |
|---|---|
| `workflow_start` | `apnea start <goal>` / `resume` / `abandon` |
| `dispatch_role` | `apnea dispatch <kind> [--rework]` |
| `workflow_wait` | `apnea wait [--timeout=<ms>]` |
| `workflow_commit_phase` | `apnea commit [--done] [msg]` |
| `workflow_status` | `apnea status` |
| *(CLI/slash only)* | `apnea reset-rounds <gate>` |
| *(CLI/slash only)* | `apnea setup [--project] [--force] [--agents-md]` |

## Self-describing output

`ToolOk` gains `legal_next?: string[]`, reusing the field name already on `ToolErr`
(`result.ts:9`) rather than introducing a parallel concept. Workflows emit **canonical tool
names** and stay harness-neutral; a shared `nextAfter(step)` helper over the existing
`LEGAL_TOOLS` map computes them, so success and refusal paths agree by construction.

Rendering is per-driver, in `format.ts`:

- Pi renders `dispatch_role` — the model calls a tool.
- CLI renders `apnea dispatch <kind>` — the caller runs a command.

Same canonical value, two surfaces. This is what lets a cold agent drive the loop from
output alone, and it survives context compaction in a way a preloaded doc does not.

`--json` emits the `ToolResult` verbatim (`{ok, message|error, legal_next, data}`). The human
default keeps the existing `formatResult` rendering.

**Exit codes:** `0` success · `1` refusal or error · `2` usage error · `3` wait budget
expired, retry. A scripted caller must distinguish "call `apnea wait` again" from "this run
is stuck", and both are non-zero.

## Resumable wait

The only behavioral change in this design.

### The bug the port would introduce if unhandled

`wait.ts:250` computes `deadline = startedMs + timeout` in-process, and the recovery ladder
— nudge after 90s idle, extend the budget once by `max(50%, 2m)`, final 3m grace — is all
in-memory. Chunking `wait` into repeated CLI calls turns "extend once" into "extend once per
invocation", i.e. unbounded: a hung role would never time out. The ladder must persist
alongside the clock.

### State additions

In `extension/schema/state.ts`, all nullable with `null` defaults so existing `state.json`
files still decode:

```
pending_started_at   : number | null   // epoch ms, set by dispatch
pending_deadline_ms  : number | null   // started_at + role timeout from config
pending_nudged_at    : number | null   // last nudge, survives invocations
pending_extended     : boolean         // one-time extension consumed
```

`dispatch_role` sets `pending_started_at` and `pending_deadline_ms` when it writes
`pending_artifact`; they clear together. `schema.test.ts:94` asserts the exact key set and
updates with them.

### Budget

`min(shell_budget, pending_deadline_ms - now)`. `shell_budget` defaults to 300s —
comfortably under Claude Code's 600s shell cap and every other harness surveyed —
overridable with `--timeout`. The *role* timeout stays in config and is enforced across
calls via the persisted deadline, so chunking does not weaken it.

### Outcomes

| Condition | Result | Exit |
|---|---|---|
| Artifact complete | `ok:true`, `data.artifact` | 0 |
| Budget spent, deadline not reached | `ok:true`, `data.pending:true`, `legal_next:["workflow_wait"]` | 3 |
| Deadline exceeded | `ok:false` `WaitTimeout` | 1 |

Exit 3 pairing with `ok:true` is deliberate: nothing failed, the role is still working. The
exit code distinguishes "call again" from "ready" for shell callers; JSON callers read
`data.pending`.

Pi is unaffected in feel — it passes a large `--timeout` and keeps streaming `onUpdate` in
one long call. Both drivers consult the same persisted deadline, so the guardrail is
identical; Pi just spends its budget in one chunk.

## Human gate

`apnea reset-rounds <gate>` refuses unless both `stdin` and `stdout` are TTYs, then requires
the human to type the gate key back verbatim. Agents shelling out get captured pipes and
fail closed with an actionable message. `--i-am-human` is the escape hatch for scripts and
remote shells.

**What this actually buys.** An agent *can* pass `--i-am-human`. The property is not
prevention, it is auditability: lifting the rework cap goes from invisible to a flag
literally named `--i-am-human` sitting in the transcript a human reviews.

**Consequence for the Pi driver.** `workflow_reset_rounds` leaves the Pi tool set entirely
(`tool: null`, same as `setup`), reachable only via the CLI or `/apnea reset-rounds` — both
human-typed channels. This closes an existing gap: [ADR 0002](../../adr/0002-orchestrator-authority.md)
claims an allowlist excludes the tool, but `state-machine.ts:21-45` lists it as legal in five
of eight steps, and Apnea cannot restrict the user's own Pi session anyway. Today the
guarantee rests on `briefs/orchestrator.md:8` convention. ADR 0002 is amended to describe the
TTY gate as the real mechanism.

## Documentation

- `skills/apnea-orchestrator/SKILL.md` and `briefs/orchestrator.md` gain a CLI column
  alongside tool names — one loop, two invocation surfaces. The brief's existing "if tools
  are missing, follow the loop using Herdr + files only" fallback becomes "use the `apnea`
  CLI", turning a manual path into a real one.
- `apnea setup --agents-md` writes a compact loop primer to `AGENTS.md` for harnesses that
  read it.
- New ADR 0009 records the CLI/driver split.
- `README.md` gains CLI install and usage.

## Distribution

`bin: { apnea: "./dist/cli.js" }`, built with `bun build --target=bun`, `prepublishOnly`
wired up, `dist` added to `files`. `pi.extensions` keeps pointing at `./extension` source —
Pi loads `.ts` directly, so the plugin path is unchanged and one package serves both
consumers.

Bun is a runtime requirement. Acceptable: role harnesses are heavier dependencies, and a
Node-compatible target remains available later by switching `--target` if reach demands it.

## Error handling

No new taxonomy. `runToolResult` already maps `AppError → ToolResult` and defects to `bug:`.
The CLI adds only surface-level handling: unknown verb or missing positional → exit 2 with
help text; everything else flows through the existing mapper.

## Testing

**The regression guarantee is the existing suite.** No test file imports the Pi API — 24 of
the 25 exercise `workflows/`, `services/`, `domain/`, and `schema/` through Effect layers,
and the 25th (`adapters/commands.test.ts`) covers `parseFlags`, which moves to
`cli/parse.ts` and takes its tests with it. If the port is correct they all pass unchanged.
An edit to one of them is a signal the port leaked into the core, not a chore.

**Resumable wait** — new semantics, heaviest coverage. Written to fail if persistence is
dropped:

- The one-time extension is granted at most once *across invocations*: call `wait` three
  times against a hung role, assert exactly one extension and a real `WaitTimeout` at the
  end. Fails loudly if `pending_extended` is not persisted — the exact bug chunking would
  introduce.
- The deadline survives process boundaries: dispatch, expire a short budget twice, assert
  the deadline derives from `pending_started_at` and does not restart.
- Budget-spent-with-deadline-remaining yields `pending`, not `WaitTimeout` — the distinction
  the exit codes rest on.
- A nudge is not re-fired on the next invocation merely because the process is new
  (`pending_nudged_at`).

**Registry parity** — a key-set assertion in the style of `schema.test.ts:94`: verb
uniqueness, every tool-facing entry has a param schema, and the full command set pinned so
adding one is a deliberate test edit. This is what makes "the drivers cannot desync" real
rather than aspirational.

**TTY gate** — `isTty` becomes an injected dep following the existing `SetupDeps` pattern
(`adapters/setup.ts:17`), so both branches are testable without a pty. Asserts a non-TTY
caller is refused *and* that the refusal names the escape hatch.

**State back-compat** — a `state.json` written before this change still decodes, new fields
defaulting to `null`. Protects anyone mid-run across the upgrade.

**CLI smoke** — one `extension/test/cli.smoke.test.ts` spawning the built binary in a temp
repo: exit 0 on `status` with no run, exit 2 on unknown verb, `--json` parses. Deliberately
thin; the logic is covered above.

## Risks

- **Bun-only reach.** Agents on machines without Bun cannot run `apnea`. Mitigated by the
  `--target=node` switch remaining open.
- **Wait chunking changes failure timing.** A role that dies between invocations is detected
  on the next call rather than immediately. Bounded by the poll interval; acceptable.
- **`--i-am-human` is bypassable.** Stated plainly above; the design buys auditability, not
  prevention.
