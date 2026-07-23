# Authenticated machine-local control service (issue #46)

Status: **foundation only — not wired into any installer, systemd unit,
timer, or the live scheduler.** This is a manually-launched service for an
operator on the same machine. See `TheTekTeam/agent-runner#41` for the MVP
sequencing this slice belongs to, `#5` for the separate reliability/live-
activation gate, `#40` for the agent-lifecycle settings contract this
service writes to, and `#45` for the protected secret store it integrates
with write-only.

## What this adds

- `scripts/ops/agent-runner-control-settings-store.mjs` — atomic,
  optimistically-versioned read/write access to the same
  `agent-settings.json` file `agent-runner-agent-settings.mjs` (#40) already
  reads. A write here is a normal file write with no cache in front of it,
  so the very next `getAgentSettings()`/`isAgentRoutable()` call — the
  pre-claim gate — sees it, with no service restart required.
- `scripts/ops/agent-runner-control-instances.mjs` — the instance registry:
  creation gated to the approved `AGENT_ADAPTERS` catalogue
  (`agent-runner-agents.mjs`), a positive field allowlist for updates
  (`model`, `profile`, `endpoint`, `timeout`, `maxConcurrency`, `policy`),
  the four #40 lifecycle transitions (`enabled`/`paused`/`draining`/
  `disabled`), derived read-only `unsupported`/`unavailable` states, and the
  `claimEligibility()`/`evaluateClaimEligibility()` pre-claim gate.
- `scripts/ops/agent-runner-control-readiness.mjs` — deterministic,
  zero-process-spawn readiness checks (a pure `accessSync` walk of `PATH`)
  and a read-only "current load" derived from the existing dashboard
  summary.
- `scripts/ops/agent-runner-control-auth.mjs` — operator authentication
  (scrypt-hashed credential verifier, never the plaintext password) and
  in-memory, expiring, HttpOnly/`SameSite=Strict` sessions.
- `scripts/ops/agent-runner-control-csrf.mjs` — double-submit CSRF token
  validation and strict loopback-only Origin/Referer validation.
- `scripts/ops/agent-runner-control-audit.mjs` — an append-only audit trail
  that is structurally incapable of carrying a value: its only content
  parameter is `changedFields: string[]`.
- `scripts/ops/agent-runner-control-server.mjs` — the `node:http` server
  wiring all of the above together, with a hard loopback-only bind refusal
  checked *before* any `listen()` call.

Nothing here modifies `claude-runner-cron.mjs`, `agent-runner-agents.mjs`,
or any ModelSpend product code. `claimEligibility()`/
`evaluateClaimEligibility()` prove the disabled/draining-ineligible
property in isolation (see Validation below); wiring that gate into the
live scheduler is explicitly out of scope for this issue (see
`prohibited_work` in the governing manager packet: no automatic routing, no
live issue execution, no scope expansion into multi-agent routing).

## Running it

There is no installer, systemd unit, or CLI flag that starts this
automatically. To try it locally:

```bash
node -e "
import('./scripts/ops/agent-runner-control-auth.mjs').then(({ setOperatorCredential }) => {
  setOperatorCredential({ username: 'operator', password: 'a-strong-local-password-16+chars' });
});
"
node scripts/ops/agent-runner-control-server.mjs --port 8787
```

The server binds `127.0.0.1` by default. Any other `--host` value throws
before a socket is ever opened — see "Loopback-only binding" below.

## Four sinks, never a fifth

Every request handler in `agent-runner-control-server.mjs` only ever
touches:

1. the control settings document (`agent-settings.json`) — metadata and
   `secretref:`-shaped strings only, never a secret value;
2. the #45 protected secret store — values, **write-only**: nothing in this
   service ever reads a value back out of it;
3. the control audit log — actor/source/time/revision/changed-field-*names*
   only;
4. the operator-credential verifier — a scrypt hash comparison only.

Nothing here opens the runner SQLite state DB for writing. The only SQLite
*read* is `computeInstanceLoad()`'s reuse of the existing, already-exported
`buildRunnerDashboard()` — the same read-only summary the static dashboard
already renders — to report whether `claude-code-cli` currently has an
outstanding claim. This is the concrete, structural reason a secret value
can never reach SQLite, dashboard payloads, or a snapshot: there is no code
path from a secret value to any of those three.

No route logs a request body. A validation failure on a bad secret value
reports a bounded reason code (`secret-value-required`,
`secret-create-failed`, …), never an echo of what was submitted.

## Loopback-only binding

`resolveBindHost()` checks the requested host against an allowlist of
exactly `127.0.0.1`, `localhost`, `::1` and throws
`AGENT_RUNNER_CONTROL_NON_LOOPBACK_BIND_REFUSED` for anything else —
`0.0.0.0`, a LAN IP, a hostname — **before** `createControlServer()`
constructs anything that could be passed to `listen()`. There is no flag,
environment variable, or code path in this foundation that reaches
`server.listen()` with an unvalidated host. LAN exposure behind an
authenticated reverse proxy is explicitly out of scope for this
implementation (see the governing manager packet's `scope`).

## Authentication and sessions

`setOperatorCredential()` is a local, machine-local bootstrap/rotation
function — it is **never** exposed as an HTTP route, since there would be
no way to authenticate a request to change the credential before one
exists. It stores `{ algorithm: 'scrypt', salt, hash }` at mode `0600`
(`~/.local/state/agent-runner/control-operator.json` by default, override
with `AGENT_RUNNER_CONTROL_OPERATOR_PATH`) — never the plaintext password.

`POST /api/session/login` verifies with `crypto.timingSafeEqual` and, on
success, issues an in-memory session: a random 32-byte session id (an
HttpOnly, `SameSite=Strict` cookie) plus a random 32-byte CSRF token
(returned in the response **body**, not the cookie — the double-submit
pattern below depends on this). Sessions are **never persisted to disk**;
a service restart always requires a fresh login. This is a deliberate
trade-off: no session token exists anywhere for "restart persistence" to
even be a question for.

## CSRF and origin

Every mutating route (`POST`/`PATCH`/`DELETE`) requires an `X-CSRF-Token`
header that matches the session's token via `crypto.timingSafeEqual`. A
cross-site request can rely on the browser attaching the session cookie
automatically, but has no way to read the login response body to learn the
token — that is the double-submit property.

Independently, **every** API request (read or write) is checked against a
strict `Origin` (falling back to `Referer`) allowlist built from the
loopback host/port the server actually bound to. A missing header or any
value outside that allowlist — including a LAN address — is rejected with
`403`, before authentication is even checked.

## Instance registry

An "instance" is one entry, keyed by agent id, in the control settings
document's `agents` map (the same map `agent-runner-agent-settings.mjs`
reads). `POST /api/instances` only accepts an `agentId` present in the
frozen `AGENT_ADAPTERS` catalogue (`agent-runner-agents.mjs`) — there is no
path to register an arbitrary/unknown adapter id.

Updates (`PATCH /api/instances/:id/settings`) go through a **positive**
field allowlist — `model`, `profile`, `endpoint`, `timeout`,
`maxConcurrency`, `policy` — and reject the entire update (not partially)
if any submitted field is outside it. `executablePath` and any future
adapter-specific field are structurally unreachable through this API.
`endpoint` accepts only loopback `http(s)` URLs. `maxConcurrency` accepts
only the literal `1` — there is no writable value that increases
concurrency. `policy` is a closed two-key object
(`requireHumanApproval`, `notes`); there is no key anywhere in this API
that can enable paid fallback or automatic routing.

Lifecycle transitions (`POST /api/instances/:id/lifecycle`) only ever
accept `enabled`, `paused`, `draining`, `disabled` — the exact #40
contract. `unsupported` (the adapter is not `implemented`) and
`unavailable` (a readiness probe failed) are computed at read time in
`deriveInstanceState()` and are never accepted as a transition target.

## Deterministic readiness, no paid or live provider calls

`probeCommandOnPath()` is a pure, synchronous `PATH` walk
(`accessSync(candidate, X_OK)` per directory) — it never spawns a process
and never opens a socket. An unimplemented catalogue adapter is never
probed at all (its effective state is already forced to `unsupported`).
"Current load" reuses the existing read-only `buildRunnerDashboard()` to
report whether `claude-code-cli` has an outstanding claim; every other
adapter reports a static `capacity: 1, active: 0` (honest, not fabricated —
this foundation does not yet track their load).

## Optimistic concurrency, atomic replacement, rollback

Every settings write goes through `agent-runner-control-settings-store.mjs`:
an exclusive per-file lock serializes writers, and an optional
`expectedRevision` is checked against the on-disk revision *before*
anything is touched — a stale write is rejected with `409` and the last
known good revision is untouched. Every successful write is a temp-file +
`rename(2)` (the same atomic-write pattern `agent-runner-secret-store.mjs`
uses), and the document it replaces is first snapshotted into a bounded
history directory. `POST /api/settings/rollback` restores a retained
revision's content as a **new**, monotonically higher revision — rollback
never rewinds the revision counter, so no other reader's optimistic-
concurrency expectations become invalid.

## Write-only secret integration (#45)

`POST /api/secrets/:id`, `POST /api/secrets/:id/rotate`, and
`DELETE /api/secrets/:id` call `createSecret`/`rotateSecret`/`removeSecret`
directly from `agent-runner-secret-store.mjs`. The submitted `value` is
read from the parsed request body and handed straight to that function —
it is never assigned to a variable that is logged, audited, or included in
a response. `GET /api/secrets/:id` returns only the safe status enum
(`configured`/`missing`/`invalid`/`rotation-required`) from
`getSecretStatus()`.

## Known limitations

- Single-operator authentication only; there is no multi-user or
  role-based access model in this foundation.
- Readiness/load reads exist only for the two catalogue entries that need
  them today (`claude-code-cli`'s PATH presence and dashboard-derived
  load); other adapters report a static "not yet tracked" load rather than
  a live probe, since wiring their `implemented: false` catalogue entries
  to real health checks is future, separately-scoped work.
- No HTML/browser client ships with this foundation — API/`curl` only —
  which is also how "no provider token in browser storage" is made moot
  rather than merely avoided.
- LAN exposure behind an authenticated reverse proxy, live routing wiring
  into `claude-runner-cron.mjs`, concurrency beyond 1, and the recurring
  execution timer all remain explicitly out of scope.

## Validation

```bash
node --check scripts/ops/agent-runner-control-settings-store.mjs \
  scripts/ops/agent-runner-control-instances.mjs \
  scripts/ops/agent-runner-control-readiness.mjs \
  scripts/ops/agent-runner-control-auth.mjs \
  scripts/ops/agent-runner-control-csrf.mjs \
  scripts/ops/agent-runner-control-audit.mjs \
  scripts/ops/agent-runner-control-server.mjs

node --test scripts/ops/agent-runner-control-settings-store.test.mjs \
  scripts/ops/agent-runner-control-instances.test.mjs \
  scripts/ops/agent-runner-control-readiness.test.mjs \
  scripts/ops/agent-runner-control-auth.test.mjs \
  scripts/ops/agent-runner-control-csrf.test.mjs \
  scripts/ops/agent-runner-control-audit.test.mjs \
  scripts/ops/agent-runner-control-server.test.mjs

node --test scripts/ops/agent-runner-agent-settings.test.mjs \
  scripts/ops/agent-runner-agents.test.mjs \
  scripts/ops/agent-runner-secret-store.test.mjs \
  scripts/ops/agent-runner-secret-reference.test.mjs \
  scripts/ops/agent-runner-secret-environment.test.mjs \
  scripts/ops/agent-runner-ollama-adapter.test.mjs

npm test
npm run validate
git diff --check
```
