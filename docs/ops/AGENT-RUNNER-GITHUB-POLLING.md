# Agent Runner GitHub polling fallback

Issue: `TheTekTeam/agent-runner#114`

The polling fallback makes the reusable event pipeline operational on a Dell before the hardened webhook transport in #105 is deployed. It polls every enabled project through the same read-only GitHub client, writes normalized deterministic deliveries into the same ingress ledger, and runs the same debounce/check-settlement/controller path.

Webhook events remain the preferred low-latency wake-up mechanism. Polling is both the initial go-live path and the durable reconciliation fallback for delayed or missed webhook deliveries.

## What one cycle does

For every enabled project:

1. read repository metadata and default branch;
2. read the current default-branch commit SHA;
3. list issues updated since the overlap-safe cursor;
4. list all currently open PRs;
5. fetch full PR state for every changed or open PR;
6. emit deterministic issue, PR and default-branch delivery envelopes;
7. advance the project cursor only when every required paginated read succeeds;
8. attach new deliveries to event batches;
9. query all relevant CI surfaces for required SHAs;
10. enforce debounce, terminal CI and final quiet-period recheck;
11. create one pending triage release per settled batch.

The cycle does not mutate GitHub or repositories.

## Cursor and deduplication

Each project has a durable cursor in `github_poll_cursors`:

- canonical repository;
- last successful poll timestamp;
- last observed default-branch SHA.

Issue polling subtracts a configurable overlap from the prior successful timestamp. Overlap replay is harmless because every envelope has a deterministic delivery ID and bounded state hash.

On first run, issues use a bounded lookback window and all open PRs are fetched regardless of age. This ensures old but still active PRs enter the controller. The default branch always emits a bootstrap delivery on the first successful poll.

A project cursor advances only after repository metadata, default SHA, changed-issue pagination, open-PR pagination, and every required full PR read succeed. A partial or rate-limited read leaves the prior cursor unchanged.

## Data minimisation

Polling persists no issue title, body, comment, PR description, changed files, raw API payload, token, environment value or provider output.

The issue/PR state hash covers bounded routing and lifecycle fields such as number, state, updated timestamp, label names, head/base/merge SHAs and review-request identities. Only the hash and normalized event identifiers are written into the delivery ledger.

## Combined command

```bash
node scripts/ops/agent-runner-polling-controller-cycle.mjs \
  --project-registry ~/.config/agent-runner/projects.json \
  --db ~/.local/state/agent-runner/controller/controller.sqlite
```

The command prints one compact JSON result and exits. Default controls:

```text
poll overlap:          5 minutes
bootstrap lookback:    30 days
batch debounce:        60 seconds
final CI quiet period: 90 seconds
settlement timeout:    60 minutes
batch limit:           100
```

## Dell user-systemd installation

The repository includes:

```text
systemd/user/agent-runner-event-polling.service
systemd/user/agent-runner-event-polling.timer
scripts/install-event-polling-user-service.sh
```

Install and start:

```bash
cd /home/gp/projects/agent-runner

git fetch origin main
git switch main
git pull --ff-only origin main

bash scripts/install-event-polling-user-service.sh \
  --agent-runner-home /home/gp/projects/agent-runner \
  --project-registry /home/gp/.config/agent-runner/projects.json \
  --controller-db /home/gp/.local/state/agent-runner/controller/controller.sqlite \
  --enable
```

The installer:

- refuses root execution;
- verifies the checkout, registry, Node, `gh`, and current `gh` authentication;
- installs only user units;
- writes a mode-0600 environment file containing paths only;
- creates the controller state directory with restrictive permissions;
- enables the timer only when `--enable` is provided;
- runs one immediate read-only cycle after enabling.

It writes no token or webhook secret.

## Service hardening

The one-shot service uses:

- `NoNewPrivileges=true`;
- private temporary storage;
- read-only home and system views except the Agent Runner state directory;
- a narrow network address-family set needed by GitHub HTTPS and local sockets;
- restrictive umask;
- a bounded service timeout.

The timer runs approximately once per minute with a small random delay and persists across reboot.

## Verification

```bash
systemctl --user status agent-runner-event-polling.timer --no-pager
systemctl --user status agent-runner-event-polling.service --no-pager
systemctl --user list-timers agent-runner-event-polling.timer --all
journalctl --user -u agent-runner-event-polling.service -n 50 --no-pager
```

The service output is compact JSON and must not contain raw GitHub payloads or credentials.

SQLite read-only inspection:

```bash
DB="$HOME/.local/state/agent-runner/controller/controller.sqlite"
sqlite3 -readonly "$DB" '.tables'
sqlite3 -readonly "$DB" \
  "select project_id,last_success_at,last_default_sha from github_poll_cursors order by project_id;"
sqlite3 -readonly "$DB" \
  "select state,count(*) from event_batches group by state order by state;"
sqlite3 -readonly "$DB" \
  "select state,count(*) from event_triage_releases group by state order by state;"
```

## Current operational boundary

After installation, the Dell automatically:

- discovers issue/PR/main changes;
- waits for all relevant GitHub checks and jobs;
- applies the final CI quiet-period recheck;
- creates durable triage releases.

It does **not yet**:

- mutate labels or close issues;
- invoke implementation agents;
- create or merge PRs;
- delete branches or worktrees.

Those begin with #113 and subsequent PR/merge controller issues. Keeping the polling loop read-only during first deployment provides live evidence before mutation authority is enabled.

## Validation

```bash
node --check scripts/ops/agent-runner-github-polling-source.mjs
node --check scripts/ops/agent-runner-polling-controller-cycle.mjs
node --check scripts/ops/agent-runner-github-polling-source.test.mjs
bash -n scripts/install-event-polling-user-service.sh
systemd-analyze --user verify \
  systemd/user/agent-runner-event-polling.service \
  systemd/user/agent-runner-event-polling.timer
node --test \
  scripts/ops/agent-runner-project-registry.test.mjs \
  scripts/ops/agent-runner-event-ingress.test.mjs \
  scripts/ops/agent-runner-event-settlement.test.mjs \
  scripts/ops/agent-runner-github-checks-provider.test.mjs \
  scripts/ops/agent-runner-event-controller.test.mjs \
  scripts/ops/agent-runner-github-polling-source.test.mjs
bash scripts/validate.sh
```
