# Standalone Agent Runner operations console (issues #175 and #174)

Status: **permanent machine-local operations surface served by the hardened `agent-runner-control.service`.** It is loopback-bound and authenticated, defaults to `127.0.0.1:8789`, and is not exposed directly to LAN/public networks. Remote browser use is tunnel-only. See [`AGENT-RUNNER-CONTROL-SERVICE.md`](AGENT-RUNNER-CONTROL-SERVICE.md) for lifecycle and hardening, and [`AGENT-RUNNER-CONTROL-API.md`](AGENT-RUNNER-CONTROL-API.md) for the HTTP security/data contract.

Port `8787` is event ingress and is unrelated to this console.

## The five-second question set

An operator should be able to answer quickly:

1. is the runner healthy and is unattended execution enabled;
2. is it idle/running/paused/degraded/blocked/awaiting attention;
3. what is current, on which agent, and for how long;
4. what is queued versus skipped and why;
5. how much included quota/headroom remains;
6. which agents are enabled/ready/constrained/disabled/unsupported;
7. what happened recently; and
8. whether anything is waiting on a human.

## Information architecture

The one app shell remains hash-routed across Overview, Agents, Activity, and Settings & audit. `GET /api/overview` remains the sole live-state projection for Overview/Activity. The browser does not invent a second runner model or fabricate runnable counts.

- **Overview** — current task, scheduler/quota/queue/fleet/health/runs summaries, operator-action list, recent activity, and companion links.
- **Agents** — fleet table plus a detail drawer for settings, write-only credentials, and lifecycle controls.
- **Activity** — bounded runner and operator configuration events with source labels.
- **Settings & audit** — safe service status, control audit history, and settings revision/rollback controls.

## Security properties

The security properties established by #45/#46/#47/#175 are preserved: production loopback binding; authentication on dynamic reads/writes; strict Origin/Referer checks and CSRF on mutations; HttpOnly `SameSite=Strict` memory-only sessions; write-only credentials; positive static-asset allowlisting with CSP/`nosniff`; no external JS/CSS/font/CDN/telemetry dependency; bounded polling/payloads; and fail-closed presentation when operational data is missing.

The hardened unit adds filesystem/process isolation without changing the application contract. Only control settings, the protected secret directory, and the exact control audit file are writable; execution SQLite, the operator credential, locks, source-activation evidence, and the remainder of Agent Runner state are read-only.

## Browser access

On the Dell itself, open `http://127.0.0.1:8789/`. From another machine, forward an authenticated operator-controlled tunnel to `127.0.0.1:8789`; do not bind the service to a LAN address and do not publish it through an unauthenticated reverse proxy.

The operator credential is bootstrapped separately. The service installer never creates or rotates it.

## Service lifecycle

```bash
scripts/install-control-dashboard.sh install
scripts/install-control-dashboard.sh verify
scripts/install-control-dashboard.sh status
scripts/install-control-dashboard.sh enable
scripts/install-control-dashboard.sh disable
scripts/install-control-dashboard.sh remove
```

An unchanged reinstall does not restart an already-running service, preserving memory-only sessions. A changed upgrade validates before mutation and restores the prior unit plus enabled/active state if replacement, activation/restart, listener, or shell-health verification fails.

`remove` removes the user unit only. Settings, operator credential, secrets, audit history, runner SQLite, implementation lock, and source-activation evidence are preserved.

## Grafana independence

Grafana remains an independent read-only observability surface fed by the exporter. The operations console does not proxy Grafana and its health does not depend on Grafana availability. Optional companion links remain links only.

## Known limitations and field acceptance

Queue drill-down remains summary-only; no fabricated runnable count is introduced. The runner still uses the existing serial execution semantics; this service issue does not alter scheduler/admission/provider/quota/concurrency behavior.

Repository validation is not Dell acceptance. After merge, a separately authorised field gate must verify the real Dell unit, exact `127.0.0.1:8789` listener, tunnel-based browser flow, credential/login behavior, restart/session semantics, rollback, and preservation of event ingress `8787` plus all unrelated runner/Grafana/GitHub state.

## Validation

```bash
node --test scripts/ops/agent-runner-control-dashboard-service.test.mjs \
  scripts/ops/agent-runner-control-overview.test.mjs \
  scripts/ops/agent-runner-overview-view.test.mjs \
  scripts/ops/agent-runner-control-server.test.mjs \
  scripts/ops/agent-runner-control-static.test.mjs \
  scripts/ops/agent-runner-agents-dashboard-view.test.mjs
npm test
npm run validate
```
