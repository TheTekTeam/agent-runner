# Agent Runner read-only observability exporter

Issue: `TheTekTeam/agent-runner#1`

The exporter exposes a bounded, read-only view of the canonical Agent Runner state for the Dell observability stack. It uses an exporter-specific SQLite projection that opens the database in read-only mode, enables SQLite query-only operation, requires the exact supported schema and selects only explicitly allowlisted columns.

## Endpoints

The service binds only to `127.0.0.1:9914`:

```text
GET /metrics
GET /healthz
GET /events.ndjson
```

All other paths return `404`; non-read methods return `405`.

### `/metrics`

Prometheus exposition includes:

- exporter and schema compatibility;
- state and operator status;
- active issue identity using bounded current-state labels only;
- persisted row counts by allowlisted table;
- bounded-window scheduler and issue-run outcomes;
- quota usage, attention and notification state;
- current systemic/degraded conditions;
- last selection, claim, poll and terminal-result timestamps.

The metrics endpoint does not expose raw payloads, paths, prompts, comments, provider responses, tokens, arbitrary labels or errors.

### `/events.ndjson`

The event feed is capped at 100 events and 256 KiB. Every record is a positive allowlist containing only:

```text
timestamp
event_type
repository
project
issue_number
phase
outcome
reason_code
duration_seconds
node
correlation_id
```

High-cardinality or sensitive internal identifiers are not exported.

## Install on the Dell

Run as the normal `gp` account, not root:

```bash
cd /home/gp/projects/agent-runner
bash scripts/install-observability-exporter.sh install \
  --config /home/gp/.config/agent-runner/modelspend.json
```

Verify:

```bash
bash scripts/install-observability-exporter.sh verify
bash scripts/install-observability-exporter.sh status
curl -fsS http://127.0.0.1:9914/healthz | jq
curl -fsS http://127.0.0.1:9914/metrics | head
```

Disable or remove independently:

```bash
bash scripts/install-observability-exporter.sh disable
bash scripts/install-observability-exporter.sh remove
```

## Prometheus boundary

The Dell Prometheus deployment uses host networking, so it can scrape `127.0.0.1:9914` directly. The exporter must not be rebound to `0.0.0.0`, a LAN address or a Docker bridge address merely to support collection.

## Security properties

- loopback-only listener;
- `DatabaseSync(..., { readOnly: true })`;
- SQLite `query_only` and `trusted_schema=OFF` safety pragmas;
- exact schema-version compatibility;
- fixed table and column allowlists;
- no SQL or arbitrary query endpoint;
- no use of the normal migrating/writable state store;
- no GitHub mutation, claim, execution, model call or runner control;
- fail-closed unsupported schema handling;
- bounded history, event count and response size;
- positive field and label allowlists;
- hardened independent systemd user service;
- database hash regression proving projection does not mutate the SQLite file;
- legacy static dashboard retained until Grafana parity is field-proven.
