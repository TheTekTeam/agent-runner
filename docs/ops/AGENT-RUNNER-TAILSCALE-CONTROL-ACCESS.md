# Agent Runner Tailscale HTTPS control access

Issue #277 adds a narrow prerequisite for permanent Tailscale HTTPS access to the authenticated control dashboard without changing its loopback-only bind.

## Security model

The control service remains bound only to `127.0.0.1:8789`. Port `8787` remains reserved for event ingress. Tailscale must terminate HTTPS separately and reverse proxy to `http://127.0.0.1:8789`; the backend port itself must never be exposed on a LAN, public, wildcard, IPv6-wildcard, or Tailscale interface.

Every dynamic `/api/*` request continues to require an exact allowed Origin/Referer. By default only the loopback origins derived from the actual listener are accepted. One optional trusted proxy origin can be configured for a browser-facing HTTPS reverse proxy.

The trusted origin contract is deliberately narrow:

- exactly one origin;
- HTTPS only;
- exact hostname and optional port, no wildcard;
- no path, query, fragment, or userinfo;
- no trust of `X-Forwarded-*` headers;
- no proxy-side Origin rewriting;
- configuration is a regular file with mode `0600`; symlinks fail closed;
- malformed configuration prevents the control process from starting rather than widening trust.

CSRF tokens, operator authentication, memory-only sessions, `HttpOnly` / `SameSite=Strict` cookies, audit behavior, secret handling and all runner/scheduler/provider state boundaries are otherwise unchanged.

## Repository-managed configuration

The fixed non-secret configuration path is:

```text
~/.config/agent-runner/control-trusted-origin.json
```

Manage it only with the repository CLI:

```bash
cd /home/gp/projects/agent-runner
node scripts/ops/agent-runner-control-trusted-origin-cli.mjs show
node scripts/ops/agent-runner-control-trusted-origin-cli.mjs set 'https://HOSTNAME:PORT'
node scripts/ops/agent-runner-control-trusted-origin-cli.mjs remove
```

`set` validates and normalizes the origin, writes atomically, and enforces mode `0600`. The CLI accepts no path override. The service loads this configuration at process startup, so changing it requires a deliberate control-service restart before the new origin becomes active.

The file lives under the existing `~/.config/agent-runner` control configuration directory already permitted by the hardened user service. No environment file, secret, host bind override, unit-template substitution, or inherited user-manager environment is introduced.

## Dell field sequence

Do not configure Tailscale Serve until repository validation is green and the accepted branch is merged. Field activation must then:

1. update the clean canonical Dell checkout to the exact accepted main SHA;
2. configure the exact chosen Tailscale HTTPS origin with the repository CLI;
3. restart only `agent-runner-control.service` and verify it remains exactly on `127.0.0.1:8789`;
4. add a new, non-conflicting **tailnet-only** Tailscale HTTPS reverse proxy to `http://127.0.0.1:8789`;
5. preserve the existing public Funnel route, GitHub webhook route and WebSSH route;
6. prove HTTPS login plus authenticated reads and a bounded CSRF-protected control action;
7. prove direct LAN/Tailscale access to backend port `8789` remains unavailable;
8. prove event ingress `127.0.0.1:8787` and scheduler/event topology are unchanged;
9. verify persistence across the applicable restart/reboot gate.

For the current Dell topology, prefer a dedicated tailnet-only HTTPS port on `dev-cluster-dell.tail702af6.ts.net` rather than a path prefix, because the dashboard uses root-relative application/API paths.

## Recovery

Removing the trusted origin is independent of Agent Runner state:

```bash
node scripts/ops/agent-runner-control-trusted-origin-cli.mjs remove
systemctl --user restart agent-runner-control.service
```

Then remove only the corresponding Tailscale Serve route. Do not alter the control listener, event ingress, scheduler units, runner SQLite, provider/admission configuration, Grafana/exporter configuration, or Z790 worker role as part of recovery.
