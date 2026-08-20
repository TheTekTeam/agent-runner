# Authenticated machine-local control service (issues #46, #174, #175)

Status: **permanent repository-managed control service, loopback-only and authenticated.** The service is installed as the hardened systemd user unit documented in [`AGENT-RUNNER-CONTROL-SERVICE.md`](AGENT-RUNNER-CONTROL-SERVICE.md) and defaults to `127.0.0.1:8789`. Port `8787` is reserved for event ingress.

The HTTP security and data-boundary contract from #46 remains unchanged: the service is not a LAN/public listener, never returns secret values, never writes runner execution SQLite, and does not change scheduler, quota, provider, admission, event-transport, exporter/Grafana, or source-activation semantics.

## Starting and accessing the service

Use the lifecycle installer; do not launch a long-lived production instance manually:

```bash
scripts/install-control-dashboard.sh install
scripts/install-control-dashboard.sh verify
scripts/install-control-dashboard.sh status
```

The browser endpoint is `http://127.0.0.1:8789/` by default. Remote browser access must use an operator-controlled tunnel to that loopback endpoint. There is no supported host override.

The installer does not create or rotate the operator credential. Bootstrap it separately with `setOperatorCredential()` as described in `AGENT-RUNNER-CONTROL-SERVICE.md`.

## CLI and bind contract

`scripts/ops/agent-runner-control-server.mjs` has a production CLI default of `127.0.0.1:8789`. Its only runtime option is `--port` with a canonical decimal value from `1` through `65535`; missing, zero, signed, whitespace-padded, suffixed, leading-zero, out-of-range, duplicate, and unknown arguments are rejected. Programmatic tests may still call `listenControlServer(..., { port: 0 })` for an ephemeral socket.

The underlying `resolveBindHost()` still fails closed before `listen()` for non-loopback hosts. Production CLI/service wiring never supplies a non-loopback host.

## Writable sinks and read-only runner state

Dynamic control handlers retain the established control surfaces: control settings, the protected write-only secret store, the append-only control audit log, and in-memory authentication/session state. The persistent operator credential is read only for verification. Runner execution SQLite remains read-only; `GET /api/overview` uses the established read-only snapshot path.

No route logs request bodies. Error responses use bounded reason codes and never echo submitted secret values.

The user unit reinforces the boundary: only `~/.config/agent-runner`, `~/.local/state/agent-runner/secrets`, and the exact `~/.local/state/agent-runner/control-audit.jsonl` file are writable. The rest of Agent Runner state is read-only.

## Static shell and unauthenticated health

`GET /` and the fixed repository static assets are intentionally available before dynamic API authentication because a browser must load the login shell before a session exists. They contain no runner/settings/secret/session/audit data and use the existing CSP and `nosniff` protections.

The service installer uses a bounded unauthenticated `GET /` as its post-activation health check. It sends no credentials, cookies, CSRF token, or request body. All dynamic `/api/*` data remains protected by the existing authentication/origin/CSRF contract.

## Authentication and sessions

The operator credential is scrypt-hashed and bootstrapped separately; plaintext is never persisted by the service. Login creates an in-memory session with an HttpOnly `SameSite=Strict` cookie and a CSRF token. Sessions are intentionally memory-only, so a service restart requires login again. This is why an unchanged reinstall is explicitly restart-free.

Every authenticated API read/write is subject to strict loopback Origin/Referer validation. Mutations additionally require the session CSRF token.

## Existing API contracts

The #46/#175 contracts remain authoritative: instances are limited to approved adapters; settings writes use positive allowlists and optimistic revisions; lifecycle targets remain bounded; credentials remain write-only; `GET /api/overview` remains a positive-allowlist read-only projection; and readiness does not make paid/live provider calls.

Grafana must not consume the control API. Grafana continues to use the independent read-only exporter.

## Service lifecycle and validation

See `AGENT-RUNNER-CONTROL-SERVICE.md` for install/verify/status/enable/disable/remove, strict port validation, rendered-unit hardening, collision checks, exact listener verification, changed-upgrade rollback, state preservation, and the post-merge Dell acceptance gate.

Focused service coverage is in `scripts/ops/agent-runner-control-dashboard-service.test.mjs`; the existing control-server/security tests remain authoritative for HTTP behavior.

```bash
bash -n scripts/install-control-dashboard.sh
node --check scripts/ops/agent-runner-control-server.mjs \
  scripts/ops/agent-runner-control-server-core.mjs \
  scripts/ops/agent-runner-control-server-cli.mjs
node --test scripts/ops/agent-runner-control-dashboard-service.test.mjs \
  scripts/ops/agent-runner-control-server.test.mjs \
  scripts/ops/agent-runner-control-static.test.mjs
npm test
npm run validate
git diff --check
```
