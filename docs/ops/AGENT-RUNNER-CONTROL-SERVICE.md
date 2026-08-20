# Permanent Agent Runner control dashboard service (issue #174)

The authenticated Agent Runner control dashboard is a **systemd user service** bound only to `127.0.0.1`. Its permanent default endpoint is:

```text
http://127.0.0.1:8789/
```

Port `8787` is reserved for Agent Runner event ingress and is not used or managed by this service. Both the production server CLI and installer reject `8787` even when no ingress listener is currently present.

## Security boundary

The service remains machine-local. Do not expose it directly on a LAN or public interface. Browser access from another machine must use an authenticated operator-controlled tunnel (for example SSH or a Tailscale tunnel) that terminates on the Dell and forwards only to `127.0.0.1:8789`. The application itself still performs session authentication, origin checks, and CSRF protection for dynamic API requests.

The repository unit uses the following hardening without capability-transition directives:

- `NoNewPrivileges=true`
- `PrivateTmp=true`
- `ProtectSystem=strict`
- `ProtectHome=read-only`
- `RestrictAddressFamilies=AF_UNIX AF_INET`
- `LockPersonality=true`
- `RestrictRealtime=true`
- `RestrictSUIDSGID=true`
- `MemoryDenyWriteExecute=true` together with Node `--jitless`
- `UMask=0077`
- bounded restart rate, start/stop timeouts, `TasksMax`, and `MemoryMax`

`ExecStart` runs Node with `--jitless`. The unit contains a fixed allowlist of non-secret environment assignments: `NODE_OPTIONS=--jitless`, the canonical machine-local ModelSpend config/state and control-state paths, and the accepted generic `agent-runner-implementation.service/.timer` scheduler identity. This makes the permanent service independent of inherited user-manager path overrides while allowing short-lived snapshot children to inherit the same `MemoryDenyWriteExecute`-compatible runtime mode. No environment file is used.

The process gets write access only to:

```text
~/.config/agent-runner
~/.local/state/agent-runner/secrets
~/.local/state/agent-runner/control-audit.jsonl
```

The remainder of `~/.local/state/agent-runner` is read-only to this service, including the operator credential, runner SQLite, implementation lock, and source-activation evidence. Control load/quota reads use the existing private read-only SQLite snapshot path; they do not open the live execution database through the writable runner-state store.

The unit contains no password, token, secret value, environment file, host override, or operator-selectable checkout/config/state path override.

## Operator credential bootstrap

The installer never creates, resets, or rotates the operator password. Bootstrap or rotate it separately with the existing local credential API:

```bash
cd /home/gp/projects/agent-runner
AGENT_RUNNER_NEW_OPERATOR_PASSWORD='choose-a-strong-password' node -e "
import('./scripts/ops/agent-runner-control-auth.mjs').then(({ setOperatorCredential }) => {
  setOperatorCredential({ username: 'operator', password: process.env.AGENT_RUNNER_NEW_OPERATOR_PASSWORD });
});
"
unset AGENT_RUNNER_NEW_OPERATOR_PASSWORD
```

Use that environment value only in the local interactive shell for the bootstrap command. Never put the password in the service unit, installer arguments, repository, logs, or documentation.

## Lifecycle commands

Run the repository-owned installer as the normal operator user, never as root:

```bash
scripts/install-control-dashboard.sh install
scripts/install-control-dashboard.sh verify
scripts/install-control-dashboard.sh status
scripts/install-control-dashboard.sh enable
scripts/install-control-dashboard.sh disable
scripts/install-control-dashboard.sh remove
```

All commands accept only an optional canonical decimal `--port PORT`; the default is `8789`, and `8787` is always rejected as reserved. The host is fixed at `127.0.0.1`. No host, executable, environment-file, checkout, config, state, or arbitrary path override is accepted.

`install` runs only from a Git checkout whose root and `origin` prove the canonical Agent Runner repository, using Node 22.23.0 or newer. It installs only `~/.config/systemd/user/agent-runner-control.service` as a systemd unit rendered from repository source. Every unit-path component and the unit itself is rejected if it is a symlink. After the rendered unit has passed validation and before activation, `install`/`enable` ensure only the three approved writable application sinks exist: the control config directory, protected secret-store directory, and control audit file (plus the audit/secret parent state directory needed to contain them). Existing contents are preserved. This bootstrap never creates the operator credential and never creates, opens, migrates, or modifies runner execution SQLite, locks, or source-activation evidence.

`install` and `enable` are the only commands allowed to activate the service. `disable` and `remove` act only on `agent-runner-control.service`; `remove` deletes only the user unit and preserves Agent Runner configuration and state. If stop/disable cannot be verified, removal fails and preserves the unit file.

### Idempotent reinstall

If the rendered unit is unchanged and the service is already active, `install` does **not** restart it. This preserves the control server's memory-only authenticated sessions.

### Changed upgrade and rollback

A changed unit is rendered and validated before the installed service is touched. The installer records whether the previous unit was present, enabled, and active. It then prepares only the approved writable sinks, stops the prior control process when necessary, preflights the requested port, installs the replacement, reloads the user manager, activates the service, verifies the exact listener, and performs a bounded unauthenticated dashboard-shell GET.

If replacement, reload, activation/restart, listener verification, or shell health verification fails, the installer restores the previous unit and its enabled/active state and verifies that restoration. It never rolls back or rewrites Agent Runner application state.

## Verification contract

`verify` requires all of the following:

1. the installed unit passes `systemd-analyze --user verify`;
2. `agent-runner-control.service` is active;
3. exactly one TCP listener exists on the requested port;
4. that listener is exactly `127.0.0.1:<port>` — wildcard, LAN, IPv6, and duplicate listeners fail;
5. a proxy-bypassed, size/time-bounded unauthenticated `GET /` returns both the expected Agent Runner shell identity marker and its Content Security Policy header, without credentials, cookies, CSRF tokens, or a request body.

The shell health check proves only that the static login/dashboard shell is reachable. It deliberately does not authenticate or exercise a state-changing API route.

## State preservation

`disable`, `remove`, failed upgrades, and later reinstalls must preserve at least:

- control settings;
- the operator credential;
- protected secret-store contents;
- control audit history;
- runner execution SQLite and its evidence;
- implementation locks;
- source-activation state.

The installer must not touch `agent-runner-implementation.service/.timer`, `agent-runner-modelspend.*`, event ingress/polling units, event-ingress port `8787`, GitHub issue state, scheduler semantics, provider/quota/admission logic, exporter/Grafana state, or source-activation semantics.

## Grafana independence

The control dashboard and Grafana are separate surfaces. Grafana continues to use the read-only observability exporter. The control service does not proxy Grafana, depend on Grafana availability, or change exporter configuration.

## Post-merge Dell acceptance gate

Repository/CI completion is **not** Dell deployment acceptance. After the PR is merged, a separately authorised Dell field step must:

1. confirm port `8789` is free and port `8787` remains owned by event ingress;
2. install the unit as user `gp` from the canonical checkout;
3. verify exact loopback listener and unauthenticated shell health;
4. complete an authenticated browser walkthrough through the approved tunnel;
5. prove unchanged reinstall keeps the same service process/session;
6. prove a controlled changed upgrade and rollback path;
7. confirm no runner state, execution units, event transport, Grafana/exporter, or GitHub state changed unexpectedly;
8. reboot once and prove control-service persistence and unchanged scheduler/event topology;
9. disable/remove/reinstall once and prove state preservation;
10. prove Grafana/Prometheus unavailability does not affect the standalone dashboard.

Issue #174 and this implementation explicitly do not perform that field step.
