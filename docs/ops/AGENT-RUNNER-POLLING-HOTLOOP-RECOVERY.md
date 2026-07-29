# Agent Runner polling bootstrap recovery

This procedure recovers a read-only polling installation that was started with the original 30-day bootstrap and accumulated an excessive historical delivery backlog.

## When this applies

Use this procedure only when all of the following are true:

- the polling/controller service is still operating in read-only shadow mode;
- no triage consumer has applied GitHub mutations;
- `event_triage_releases` contains no processed release that must be retained;
- the database was populated by the original unbounded bootstrap;
- the timer and service have been stopped before touching the database.

The affected first Dell activation produced 479 deliveries and 478 active batches while creating zero triage releases. Archiving that database is therefore safer than allowing historical batches to consume GitHub API capacity indefinitely.

## Corrected behaviour

The corrected polling source:

- bootstraps at most 20 issues updated in the preceding 24 hours per project;
- includes every currently open PR;
- does not bootstrap recently closed PRs;
- records one current default-branch event per project;
- continues to detect later closed/merged PR changes through overlap-safe incremental polling;
- processes at most 25 batches per service cycle;
- prints compact state and reason counts to the journal;
- schedules the next timer run one minute after the previous service run finishes.

## Stop and archive

```bash
set -euo pipefail

DB="$HOME/.local/state/agent-runner/controller/controller.sqlite"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$HOME/.local/state/agent-runner/controller/archive-$STAMP"

systemctl --user disable --now agent-runner-event-polling.timer
systemctl --user stop agent-runner-event-polling.service || true

mkdir -p "$ARCHIVE"
chmod 700 "$ARCHIVE"

for path in "$DB" "$DB-wal" "$DB-shm"; do
  if [[ -e "$path" ]]; then
    mv "$path" "$ARCHIVE/"
  fi
done

printf 'archive=%s\n' "$ARCHIVE"
```

Do not delete the archive until the corrected service has passed acceptance.

## Update and reinstall

```bash
set -euo pipefail

RUNNER="/home/gp/projects/agent-runner"
REGISTRY="$HOME/.config/agent-runner/projects.json"
DB="$HOME/.local/state/agent-runner/controller/controller.sqlite"

cd "$RUNNER"
git fetch origin main
git switch main
git pull --ff-only origin main

bash scripts/install-event-polling-user-service.sh \
  --agent-runner-home "$RUNNER" \
  --project-registry "$REGISTRY" \
  --controller-db "$DB"

systemctl --user daemon-reload
```

## Foreground acceptance

Run one corrected cycle before enabling the timer:

```bash
node scripts/ops/agent-runner-polling-controller-summary.mjs \
  --project-registry "$REGISTRY" \
  --db "$DB" \
  --bootstrap-lookback-ms 86400000 \
  --batch-limit 25
```

Expected properties:

- `polling.projectErrors` is zero;
- each project reports no more than 20 bootstrap issues;
- current open PR counts are plausible;
- the total first-run delivery count is bounded;
- the output contains aggregate `states` and `reasons`, not individual batch IDs;
- the process exits successfully within five minutes.

## Enable and verify

```bash
systemctl --user enable --now agent-runner-event-polling.timer
systemctl --user start agent-runner-event-polling.service

systemctl --user status agent-runner-event-polling.timer --no-pager -l
systemctl --user status agent-runner-event-polling.service --no-pager -l || true
systemctl --user list-timers agent-runner-event-polling.timer --all
journalctl --user -u agent-runner-event-polling.service -n 20 --no-pager -l
```

After a service run finishes, the timer must show a future trigger approximately one minute later. It must not immediately start continuous back-to-back runs.

## Rollback

```bash
systemctl --user disable --now agent-runner-event-polling.timer
systemctl --user stop agent-runner-event-polling.service || true
```

Keep the archived database and service journal until the acceptance evidence has been reconciled into issue #116.
