# Security

Apnea runs an automated loop that executes repo-controlled text through agent CLIs. That is a
real trust boundary, not an incidental detail, and it is worth stating plainly before you point
this tool at a repository.

## Trust model

- **Repo-controlled argv is not allowed.** Profiles and every `cmd_*` array resolve only from
  `~/.config/apnea/config.json` plus package defaults. A project-local `.apnea/config.json`
  that sets `cmd`, `cmd_oneshot`, `cmd_interactive`, or `bin` hard-errors at start. Project
  config may only rebind roles to profile names that already exist, and set caps and timeouts.
- **Repo-controlled text is an accepted prompt-injection surface.** Tasks, plans, verify
  commands, and vendored briefs are all repo text that reaches an agent CLI. This is
  **disclosed, not solved.** Running Apnea over a repository you do not trust hands that
  repository's text to an agent running with your credentials.
- **Planner-authored verify commands execute at the commit gate**, in the project working
  directory, in the same trust domain as the coder writing source. Their output goes to
  `verify.log`.

See [`docs/protocol/config.md`](docs/protocol/config.md) (Trust model section) and
[`docs/adr/0006-config-trust-model.md`](docs/adr/0006-config-trust-model.md) for the full
rationale.

## Supported versions

The package is pre-1.0. Only the latest release receives fixes.

## Reporting a vulnerability

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/naxodev/pi-apnea/security) on
`naxodev/pi-apnea` — open the repository's Security tab and select "Report a vulnerability".

Do not open a public issue for a security report.
