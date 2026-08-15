# Generic serial implementation recurrence migration (#210)

Issue: `TheTekTeam/agent-runner#210`

## What this is

`scripts/ops/agent-runner-implementation-recurrence.mjs` is the one generic
serial implementation recurrence. Each tick it loads the managed project
registry (#100/#177), probes every *enabled* project's existing production
probe (`claude-runner-candidate-probe.mjs`) in registry order, selects at
most one runnable project, and invokes the existing project-bound
`bin/run-project.sh` wrapper for that project's exact config -- the same
production execution seam the accepted ModelSpend-only timer already uses.
It never reimplements candidate selection, claim or execution.

`bin/run-implementation-recurrence.sh` is the ExecStart target for the
generic `agent-runner-implementation.service`/`.timer` unit pair in
`systemd/user/`.

## Project-neutral environment handoff

A machine environment scoped to one project (`GITHUB_REPOSITORY`,
`CLAUDE_RUNNER_OUTPUT_DIR`, `CLAUDE_RUNNER_STATE_DB`,
`CLAUDE_RUNNER_CRON_LOCK` -- see `PROJECT_SCOPED_ENV_FIELDS` in
`agent-runner-config.mjs`) must never leak into a probe or invocation bound
to a *different* project. Before every project-bound candidate probe and
before invoking `bin/run-project.sh`,
`buildProjectScopedInvocationEnv()` strips those four inherited vars from
the recurrence's own environment and rebinds `AGENT_RUNNER_CONFIG` /
`CLAUDE_RUNNER_CONFIG` to the selected project's exact config path. All
other inherited machine policy/environment values are preserved unchanged.
Without this, a machine environment carrying ModelSpend-scoped values (set
for manual runner use, for example) would make `bin/run-project.sh`'s own
`assertProjectScopedEnv` pre-scheduler gate refuse a differently-scoped
project such as Agent Runner with an identity-mismatch error, even though
the registry correctly selected it.

## Systemd units

- `systemd/user/agent-runner-implementation.service` / `.timer` -- the
  generic unit pair, parameterized through
  `~/.config/agent-runner/implementation-recurrence.env`
  (`AGENT_RUNNER_HOME`, `AGENT_RUNNER_PROJECT_REGISTRY`), following the same
  `${AGENT_RUNNER_HOME}`-parameterized pattern as
  `agent-runner-event-ingress.service` / `agent-runner-event-polling.service`.
- `scripts/install-agent-runner-implementation-systemd.sh` installs those
  unit files. By itself (no action flag) it only copies files, writes the
  env file, and runs `systemctl --user daemon-reload` -- it never enables,
  starts, disables or stops any unit.

## Migration and rollback

The legacy `modelspend-claude-runner.timer` (installed by
`scripts/ops/install-claude-runner-systemd.sh`) and the generic
`agent-runner-implementation.timer` must never both be live scheduling
authorities at once -- the generic recurrence already probes the
ModelSpend project through the managed registry, so running both would let
two schedulers select and invoke work concurrently.

- `--enable` refuses if the legacy timer is still enabled or active.
- `--migrate-from-modelspend-only` atomically disables the legacy timer
  and then enables+starts the generic timer.
- `--rollback-to-modelspend-only` is the exact inverse: atomically disables
  the generic timer and re-enables+starts the legacy timer. It requires the
  legacy unit files to still be installed (this script never removes them)
  and fails closed if they are not.
- `--dry-run` changes no file and issues no `systemctl` call, for any
  action.

None of this installs, activates, enables or disables anything by itself --
it must be run explicitly by an operator on the target machine (Dell), and
this migration adds no scheduler authority to Z790.
