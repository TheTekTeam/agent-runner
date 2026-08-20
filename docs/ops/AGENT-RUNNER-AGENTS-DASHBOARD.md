# Authenticated Agents dashboard (issues #47, #175, #174)

Status: **permanent machine-local dashboard served by `agent-runner-control.service`.** The current four-section operations console extends the original Agents dashboard while preserving its security model. The service defaults to `127.0.0.1:8789`; port `8787` remains reserved for event ingress.

See [`AGENT-RUNNER-OPERATIONS-CONSOLE.md`](AGENT-RUNNER-OPERATIONS-CONSOLE.md), [`AGENT-RUNNER-CONTROL-API.md`](AGENT-RUNNER-CONTROL-API.md), and [`AGENT-RUNNER-CONTROL-SERVICE.md`](AGENT-RUNNER-CONTROL-SERVICE.md).

## Dashboard role

The Agents surface remains a client of the existing control API. It does not add an independent scheduler, provider call path, billing path, secret read path, or state store. The current console renders the agent fleet table and detail drawer from the approved adapter/settings/readiness contracts established by #40/#45/#46/#47.

The dashboard can show catalogue/registered instances, adapter/runtime metadata, operator lifecycle state, derived unavailable/unsupported state, readiness, model/profile, capability classes, authentication status enum, cost/quota summaries, current slot/load, settings revision/history, and bounded explanations for unavailable actions. Paid-agent enablement remains explicitly confirmed by the operator where applicable.

## Never a leak

The browser never receives or persists provider secret values, plaintext operator credentials, prompts, raw model output, filesystem paths, or session handles.

- credential inputs are write-only and cleared by the client after submission;
- the session cookie is HttpOnly and `SameSite=Strict`;
- the CSRF token is memory-only;
- browser local/session storage is not used for sensitive state;
- static assets are served only from the fixed allowlist with CSP and `nosniff`;
- dynamic data is fetched only from the same-origin authenticated `/api/*` surface;
- the service unit keeps runner execution state, operator credential, locks, and source-activation evidence read-only.

## Permanent service access

Do not use the former manual `node ... --port 8787` workflow for the permanent dashboard. Install and verify the repository-managed user service instead:

```bash
scripts/install-control-dashboard.sh install
scripts/install-control-dashboard.sh verify
scripts/install-control-dashboard.sh status
```

Then use `http://127.0.0.1:8789/` locally, or an authenticated operator-controlled tunnel to that exact loopback endpoint from another machine. The service has no supported host override and must not be exposed directly on the LAN/public network.

The operator credential is bootstrapped separately with the existing `setOperatorCredential()` helper; the installer never creates, rotates, prints, or embeds a password.

## Lifecycle and session behavior

`install`, `verify`, `status`, `enable`, `disable`, and `remove` are the only installer commands. They accept only an optional strict `--port` and default to `8789`.

An unchanged reinstall does not restart an active process, so memory-only browser sessions remain valid. A changed upgrade validates first and rolls the prior unit plus enabled/active state back on activation/restart/health failure. Removing the service preserves dashboard settings, operator credential, secrets, audit history, execution SQLite, implementation lock, and source-activation evidence.

## UX and accessibility

The current console retains semantic landmarks, keyboard-reachable controls, visible focus states, labelled forms, text-plus-glyph statuses, responsive fleet layouts, reduced-motion support, focus-managed dialogs/drawers, and bounded live announcements. Missing data is never rendered as healthy.

## Grafana independence

Grafana remains independent and continues to consume the read-only exporter. Dashboard links to Grafana are optional navigation only; Grafana availability is not a prerequisite for this control surface.

## Validation and Dell acceptance

Repository tests continue to cover the API/dashboard security properties, write-only secret flow, static shell, overview projection, and accessibility-oriented pure view logic. Issue #174 adds lifecycle/unit tests in `agent-runner-control-dashboard-service.test.mjs`.

After merge, a separately authorised Dell acceptance gate must prove the real service listener, tunnel-only browser access, authenticated workflow, unchanged-install session preservation, changed-upgrade rollback, and non-interference with event ingress `8787` and all unrelated Agent Runner/Grafana/GitHub state. This repository implementation does not perform that deployment.

```bash
node --test scripts/ops/agent-runner-control-dashboard-service.test.mjs \
  scripts/ops/agent-runner-control-static.test.mjs \
  scripts/ops/agent-runner-agents-dashboard-view.test.mjs \
  scripts/ops/agent-runner-control-server.test.mjs
npm test
npm run validate
git diff --check
```
