# Contributing

## Prerequisites

- **bun** `>=1.3.7` — this matches `engines.bun` in `package.json`. If the two ever disagree,
  the manifest wins and this document is wrong.
- **jj and git** — this repo is colocated: both `.jj/` and `.git/` exist. See
  [Version control](#version-control--jj-first) below.
- Optional, only needed to run the loop rather than develop on it: `herdr`, and at least one
  agent CLI (`pi`, `claude`, or `codex`).

## Build, test, typecheck

```sh
bun install
bun run build
bun test extension
bunx tsc --noEmit
```

**Run `bun run build` before `bun test`.** `extension/test/cli.smoke.test.ts` spawns the
bundled `dist/cli.js` as a subprocess, and `dist/` is gitignored, so a fresh checkout has
nothing to spawn until the build runs once. This is exactly why `.github/workflows/ci.yml`
orders its Build step before its Test step.

`bun test extension` scopes the run to the extension suite, which is what CI runs. Bare
`bun test` is the `scripts.test` entry and is broader.

## Version control — jj first

The repo is colocated, so both VCS tools are present and it is easy to reach for the wrong
one.

- Use **jj** for every mutating operation.
- Read-only git is fine: `git log`, `git diff`, `git show`.
- **Never** run `git add`, `git commit`, `git checkout`, `git rebase`, or `git stash` in this
  repo.
- The squash workflow: `jj describe -m "<message>"` to describe the change, `jj new` to start
  work on top, do the work, then `jj squash` to fold it into the parent. Repeat.

See [`docs/adr/0007-jj-first-commits.md`](docs/adr/0007-jj-first-commits.md) for the full
rationale; that ADR is the authority, this section only summarises it.

## Conventional Commits for PR titles

**The repo squash-merges, so the PR title lands verbatim in `git log`.** A sloppy PR title
becomes a permanent commit message — this is what makes the convention non-negotiable rather
than a style preference.

Shape: `type(scope): lowercase imperative summary (#PR)`, with the scope and PR number
optional.

Real examples from this repo's history:

```text
fix(paths): resolve the package root by manifest, not by directory depth
feat(cli): add apnea CLI over a shared operation registry (#4)
```

## What CI enforces

`.github/workflows/ci.yml`:

- Triggers on push to `main` and on every pull request.
- Cancels superseded runs for the same ref (`concurrency`, `cancel-in-progress: true`).
- Runs a single job on `ubuntu-latest`: checkout → `oven-sh/setup-bun@v2` (`bun-version:
  latest`) → `bun install --frozen-lockfile` → `bun x tsc --noEmit` → `bun run build` →
  `bun test extension`.

  (`bun x tsc --noEmit` in the workflow and `bunx tsc --noEmit` above invoke the same tool —
  just two spellings of the same command.)

CI does **not**:

- run a linter — there is no lint step,
- enforce a coverage gate,
- publish anything — there is no publish step and no release workflow; `ci.yml` is the only
  file in `.github/workflows/`.

## Release checklist

**Publishing is a human action.** No agent and no CI job performs it in this repo, and
nothing in the automated loop executes the steps below.

1. Confirm the working copy is clean and green under `bun test extension`,
   `bunx tsc --noEmit`, and `bun run build`.
2. Bump `version` in `package.json`. The package is pre-1.0, so a breaking change is a
   **minor** bump.
3. Run `npm pack --dry-run` and read the file list before publishing anything.
4. `npm publish`. This must run on a machine with `bun` on `PATH`: the `prepare` script
   shells out to `bun run build`, and npm runs `prepare` during publish.
5. Tag the release and push the tag.

`publishConfig.access` is already `"public"` in the manifest, so no `--access public` flag is
needed on the command.
