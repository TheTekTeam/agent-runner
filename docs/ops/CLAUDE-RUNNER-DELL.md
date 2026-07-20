# Claude Runner on the Dell

This is the preferred local setup for `gp@dev-cluster-dell` and similar operator machines.

## Why systemd user timers, not cron

Use the systemd user timer for the Claude runner. It keeps the job under the normal operator account, gives `systemctl --user` status, writes logs to `journalctl`, supports scheduled runs, and avoids installing anything into root's crontab.

The old cron installer remains available as a fallback only.

## Install

From the repo root:

```bash
cd ~/projects/modelspend
bash scripts/ops/install-claude-runner-systemd.sh \
  --execute \
  --allow-implementation \
  --implementation-approvers gpcola \
  --enable-linger
```

Do not use `sudo` for the installer. The runner must use the same user account that has Claude Code CLI and GitHub CLI authentication.

The three production controls are deliberately independent:

- `--execute` sets `CLAUDE_RUNNER_CRON_EXECUTE=true`, allowing the scheduler wrapper to invoke a selected child with `--execute`.
- `--allow-implementation` explicitly sets `CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true`, allowing an otherwise-authorised child to make repository changes.
- `--implementation-approvers <csv>` sets the GitHub logins allowed to author the current manager preflight or command. The installer lowercases, deduplicates and writes these as one comma-separated list.

`--execute` alone does not authorise implementation. `--allow-implementation` fails unless the same invocation supplies a valid approver list or the existing env file already contains one. GitHub logins must be 1–39 alphanumeric-or-hyphen characters, cannot start or end with a hyphen, and cannot contain consecutive hyphens. Empty list entries are rejected.

The installer never enables generated-preflight implementation. Whenever implementation settings are provisioned, it writes and verifies `CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION=false` so only a current human-authored, allowlisted preflight or command can authorise writes.

Re-running the installer with the explicit flags above is safe and intentional. It updates only installer-managed keys in the existing runner env file, collapses their duplicates, preserves unrelated entries, secrets and file mode, rewrites the canonical units, explicitly restarts the timer, and fails unless the active timer has a next trigger. It verifies requested values by key without printing the complete env file or any secret values.

The installer also fails closed when a service drop-in overrides `MODELSPEND_ENV_FILE`, `EnvironmentFile`, scheduler execution, or implementation-authorisation settings. Remove or quarantine obsolete diagnostic/read-only drop-ins before reinstalling. A dashboard-only `ExecStopPost` publisher drop-in is permitted.

Use `--dry-run` to inspect the unit and action plan without changing the env file, unit files, or systemd state. The env template and values are not printed.

If `--enable-linger` cannot run without elevated permissions, run:

```bash
sudo loginctl enable-linger gp
```

## Verify

```bash
systemctl --user status modelspend-claude-runner.timer modelspend-claude-runner.service --no-pager
systemctl --user list-timers modelspend-claude-runner.timer --all --no-pager
journalctl --user -u modelspend-claude-runner.service -n 100 --no-pager
```

The timer must be enabled and active, and `list-timers` must show a real `NEXT` timestamp. An active timer with `NEXT=-` is unscheduled and must be reinstalled/restarted rather than treated as healthy.

Run a one-off manual execution only as part of a supervised restoration after installation and queue re-authorisation:

```bash
systemctl --user start modelspend-claude-runner.service
journalctl --user -u modelspend-claude-runner.service -n 100 --no-pager
```

## Environment

The installer creates this file if it does not already exist:

```bash
~/.config/modelspend/claude-runner.env
```

Typical Dell non-secret values after explicit production provisioning:

```bash
MODELSPEND_REPO_DIR=/home/gp/projects/modelspend
CLAUDE_RUNNER_CRON_EXECUTE=true
CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true
CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=gpcola
CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION=false
```

Optional values include `GITHUB_TOKEN`, `GH_TOKEN`, `CLAUDE_BIN` and `CLAUDE_RUNNER_ARGS`. Keep secrets out of git and never paste the complete env file into issue or PR evidence.

## Remove

```bash
bash scripts/ops/install-claude-runner-systemd.sh --remove
```

## Local GitHub manager

Use the Dell-side manager for narrow human-approved issue/PR operations that scheduled ChatGPT tasks should not perform.

Dry-run examples:

```bash
node scripts/ops/github-manager.mjs close-issue --issue 629 --comment "Closed after merged PR #630."
node scripts/ops/github-manager.mjs sync-merged-pr --pr 630
node scripts/ops/github-manager.mjs close-pr --pr 123 --comment "Superseded by PR #456."
```

Execute examples:

```bash
node scripts/ops/github-manager.mjs close-issue --issue 629 --comment "Closed after merged PR #630." --execute
node scripts/ops/github-manager.mjs sync-merged-pr --pr 630 --execute
```

Safety rules:

- The manager is dry-run by default.
- It can close issues and PRs only with `--execute`.
- It never merges PRs or approves reviews.
- Scheduled ChatGPT tasks should continue to report/prepare/select work, but final closure can be done from the Dell with this CLI.
