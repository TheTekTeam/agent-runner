# Agent Runner dashboard and scheduler semantics

The local Agent Runner dashboard is a read-only view over `.var/claude-runner/runner-state.sqlite`. It distinguishes scheduler health from actual agent work so a successful empty timer tick is never presented as a successful implementation.

## Metric meanings

- **Issue executions** counts only persisted `issue-run` results. Success and failure are derived only from those rows.
- **Scheduler polls** counts every retained scheduler result, with separate no-selection and quota-blocked totals.
- **Quota** shows the latest parsed current-session and current-week percentages. Historical rows written by the old nested-payload persistence bug are recovered from `payload_json` at read time; no destructive SQLite migration is required.
- **Queue skips** shows skip event count, distinct affected issue count, and distinct reason count. Repeated timer observations are events, not new issues.
- **Runner activity** reports an active or unresolved issue only when a claim has no later terminal run result in retained history. Otherwise it explicitly shows idle state and labels the newest issue record as historical activity.
- **ETA** is derived only from completed issue-run durations and distinct outstanding issue numbers. Sparse history returns `insufficient-data` rather than inventing precision.

The dashboard includes dependency-free graphical views for recent scheduler outcomes, quota trends, and skip-reason distribution. Tables remain the detailed fallback and source for exact timestamps and log paths.

The general dashboard uses a compact 16px base scale with 14–15px supporting copy. The queue-skip distribution is intentionally rendered as normal HTML rather than SVG text so its reason labels and counts remain a true 16px at every panel width instead of shrinking with the chart viewBox.

## Scheduled quota admission

The systemd/cron wrapper runs `scripts/ops/claude-runner-candidate-probe.mjs` before an execute-mode timer pass. The probe uses the normal GitHub queue selection logic in forced dry-run mode and recognises only work with current canonical manager authority; it cannot claim, mutate GitHub, launch an agent, or invoke Claude `/usage`.

- If the probe finds runnable work with current canonical manager authority, the normal runner starts and performs its fail-closed quota check before claim and execution.
- If the probe finds no candidate, the wrapper records a dry-run `no-selection` scheduler result with quota preflight disabled. Empty timer ticks therefore do not start Claude just to discover that nothing can run.
- An unexpected probe failure stops the scheduled pass instead of silently bypassing quota admission.

Direct operator invocation of `scripts/ops/claude-runner-cron.mjs` remains available for diagnostics. Scheduled operation should use `scripts/ops/jobs/run-claude-runner.sh`, which is also the systemd service entrypoint.

## Generated preflight safety

Deterministic local preflights are not model calls. Automatic generation now requires all of the following:

- a sufficiently detailed issue body;
- explicit acceptance criteria;
- no blocking label;
- no linked open pull request;
- at least one explicit backticked source, test, configuration, migration, or documentation file path.

A detailed but path-free issue is recorded as `preflight-generation-needs-manager`. This keeps repository discovery and recent-work analysis with the manager instead of spending Claude turns on broad research.

## Canonical Dell dashboard route

The Dell host Nginx site `agent-runner-dashboard` serves the generated static files from:

```text
/var/www/agent-runner/dashboard
```

The canonical LAN URL is:

```text
http://dev-cluster-dell/runner-dashboard/
```

The Nginx site is stored at `/etc/nginx/sites-available/agent-runner-dashboard` and is enabled through the normal `sites-enabled` symlink. The path-based route must remain available even when the optional `runner.dev-cluster-dell.home.arpa` hostname is also configured.

One-time web-root preparation on the Dell:

```bash
sudo install -d -o "$USER" -g www-data -m 0755 /var/www/agent-runner/dashboard
```

Publish the dashboard from the current repository checkout using the live runner database:

```bash
node scripts/ops/claude-runner-dashboard-local.mjs \
  --db .var/claude-runner/runner-state.sqlite \
  --out-dir /var/www/agent-runner/dashboard \
  --history-limit 100 \
  --strict
```

Validate the published route:

```bash
sudo nginx -t
curl -I http://dev-cluster-dell/runner-dashboard/
curl -I http://dev-cluster-dell/runner-dashboard/styles.css
curl -I http://dev-cluster-dell/runner-dashboard/dashboard-data.js
```

All three HTTP requests must return `200`. After republishing CSS or JavaScript, perform a hard browser refresh so a cached dashboard asset is not mistaken for the new build.

## Local-only generation

For an unhosted local copy, omit `--out-dir`:

```bash
node scripts/ops/claude-runner-dashboard-local.mjs \
  --db .var/claude-runner/runner-state.sqlite
```

This writes `.agent-runner/dashboard/index.html` in the current checkout. No JavaScript framework, chart package, or external data source is required.
