# Authenticated Agents dashboard (issue #47)

Status: **foundation-complete, machine-local only — not wired into any
installer, systemd unit, timer, or LAN/public exposure.** This adds the
HTML/JS browser client that `#46`'s doc explicitly left out ("No
HTML/browser client ships with this foundation"). See
`TheTekTeam/agent-runner#41` for the MVP sequencing this slice belongs to,
`#5` for the separate reliability/live-activation gate, `#40` for the
agent-lifecycle settings contract, `#45` for the protected secret store,
and `#46` for the control API this dashboard is a client of and nothing
more.

> **Extended by issue #175.** The shell described here has since been
> raised into the four-section operations console (Overview / Agents /
> Activity / Settings & audit) documented in
> [`AGENT-RUNNER-OPERATIONS-CONSOLE.md`](AGENT-RUNNER-OPERATIONS-CONSOLE.md).
> Every security property below still holds and is still regression-tested;
> what changed is the information architecture, one added read-only route
> (`GET /api/overview`), and one added asset (`agents-overview-view.mjs`,
> so the static allowlist now holds five literal filenames rather than
> four). The per-agent required-view coverage below now renders in the
> Agents fleet table and its detail drawer rather than in a wall of cards.

## What this adds

- `.agent-runner/agents-dashboard/index.html`, `agents-dashboard.css`,
  `agents-dashboard.js`, `agents-dashboard-view.mjs` — the dashboard shell.
  `agents-dashboard-view.mjs` is a framework-free module of pure
  derivation/formatting functions (execution-surface classification, state
  explanations, capability-class listing, last-state-change lookup, the
  paid-agent confirmation gate, …); `agents-dashboard.js` is the thin
  DOM/`fetch` bootstrap that imports it. Both are plain ES modules —
  `agents-dashboard-view.mjs` is directly imported and unit-tested from
  `scripts/ops/agent-runner-agents-dashboard-view.test.mjs`, with no DOM
  shim required, because it never touches `document`/`window`/`fetch`.
- `scripts/ops/agent-runner-control-static.mjs` — a positive
  path-to-literal-filename allowlist that serves those four files. There is
  no `join(dir, request path)` anywhere in it; a pathname either matches one
  of four fixed map entries or gets `null`, so there is no traversal path to
  any file outside the dashboard's own asset directory, let alone outside
  the repository.
- `agent-runner-control-server.mjs` now serves those static GET routes
  (see `tryServeStaticAsset()`) **before** the `/api/*` origin/auth/CSRF
  gate. This is deliberate, not a gap: a top-level browser navigation to
  load the page sends no `Origin` header at all (and, on a fresh tab, no
  `Referer` either), so gating the HTML shell behind `validateOrigin()`
  would make the page permanently un-loadable. It is safe because the
  shell carries no agent, settings, secret, session or audit data of any
  kind; every dynamic value is fetched by the client-side JS afterward,
  through the fully authenticated/CSRF/origin-checked `/api/*` surface —
  same as before this issue. Static responses also carry a strict
  `Content-Security-Policy: default-src 'self'; ...` and
  `X-Content-Type-Options: nosniff` header as defense in depth.
- Two small, additive extensions to the existing #46 read surface, reusing
  its existing sinks rather than adding new ones:
  - `buildInstanceSnapshot()` (`agent-runner-control-instances.mjs`) now
    also returns `command` (the adapter's already-public runtime command,
    e.g. `claude`) and `capabilities` (the frozen, already-public
    `adapter.controls` map) on each instance snapshot — both static
    catalogue metadata that was already imported by this module, just not
    previously surfaced on the read path. It also **stops** forwarding
    `readiness.probes` into the snapshot: a probe's `detail` field can hold
    a resolved executable filesystem path, and this dashboard's mandate is
    to never let a local path reach the DOM, so the snapshot now exposes
    only `{ ok, reason }`.
  - `computeInstanceQuota()` (`agent-runner-control-readiness.mjs`) reuses
    the exact same read-only `buildRunnerDashboard()` summary
    `computeInstanceLoad()` already reads — not a new sink — to report
    `claude-code-cli`'s existing `quota` block (`blockedCount`,
    `latestSessionUsagePercent`, `latestWeeklyUsagePercent`) and an honest,
    static `costClass` (`paid-metered` / `free-local-zero-spend` /
    `not-yet-qualified`) for every adapter. There is no live billing or
    provider call anywhere in this function, for any adapter.

Nothing here modifies `claude-runner-cron.mjs`, manager/dispatch authority,
ModelSpend product code, or any #45/#46 write path. The dashboard is a
consumer of the existing `/api/*` contract exactly as documented in
`docs/ops/AGENT-RUNNER-CONTROL-API.md`; it adds no new mutation surface —
every button in the UI calls one of the routes that document already
describes.

## Required-view coverage (issue #47)

| Required view | Where it comes from |
| --- | --- |
| Catalogue + registered instances | `GET /api/instances` (unchanged #46 route) |
| Adapter, runtime, safe version | `adapterType`/`command` (new) + `describeVersionPolicy()` — an honest policy label, never a fabricated version number (there is no live version probe anywhere in this runner's control service, by design) |
| Execution surface | `classifyExecutionSurface(adapterType)` — a pure, client-side derivation from the already-public adapter type; not a new stored field |
| Operator states (enabled/paused/draining/disabled) | `POST /api/instances/:id/lifecycle` (unchanged #46 route) |
| Derived states (unavailable/unsupported) | `instance.state` (unchanged #46 field) |
| Health/implementation/qualification | `instance.readiness`, `instance.implemented` |
| Model/profile, capability classes | `instance.model`/`profile` (unchanged) + `instance.capabilities` (new, static) |
| Context/output limits | Honestly reported as "not modeled by this adapter's control surface" — this runner has no such field for any adapter; `timeout` (wall-clock, not tokens) is shown alongside it |
| Authentication status | `GET /api/secrets/:id` status enum only — never a value |
| Cost class, budget/cap, quota | `computeInstanceQuota()` (new) + `instance.policy.requireHumanApproval` (unchanged) |
| Current task/slot | `instance.load` (unchanged #46 field) |
| Readiness time, settings revision, last state change | Readiness time is stamped client-side at fetch completion; revision comes from `GET /api/settings/revisions`; last state change is derived client-side from `GET /api/audit`'s already value-free `changedFields` |
| Explanations for unavailable actions | `describeActionAvailability()` in `agents-dashboard-view.mjs` |
| Add-instance restricted to approved adapters | `POST /api/instances` (unchanged #46 gate: any id outside `AGENT_ADAPTERS` is rejected) |
| Non-secret config via #46's allowlist | `PATCH /api/instances/:id/settings` (unchanged) |
| Write-only credential create/rotate/remove | `POST`/`POST .../rotate`/`DELETE /api/secrets/:id` (unchanged #45/#46) |
| Audit/history/rollback | `GET /api/audit`, `GET /api/settings/revisions`, `POST /api/settings/rollback` (unchanged) |
| Confirmation for paid-agent enablement | A blocking in-page confirmation panel (not a native `confirm()` dialog) gates `enabled` transitions for any instance where `quota.paid === true` |
| Responsive, keyboard-accessible, monochrome | See "UX" below |

## Never a leak: sink-by-sink

The client never reads, stores, or displays a secret value, provider
credential, prompt, raw model output, session handle, or filesystem path:

- **Secret values** are write-only end to end. `agents-dashboard.js` reads
  a credential `<input type="password">`'s value into the request body and
  clears the input **synchronously, before the `await fetch(...)` that
  reads it settles** — so nothing lingers in the DOM regardless of network
  latency or the tab being closed mid-request. The server-side write-only
  contract (never returned, logged, or audited) is unchanged from #45/#46
  and is re-asserted end to end by
  `agent-runner-control-server.test.mjs`'s existing LEAK-PROOF tests, which
  now also run against the new `capabilities`/`quota` response fields.
- **Session handle**: the session cookie is `HttpOnly`, so this client-side
  JS has no way to read it even if it wanted to. The CSRF token (not a
  credential — a per-session anti-forgery value the double-submit pattern
  requires the client to hold) lives only in a module-scope closure
  variable (`sessionState.csrfToken`) — never `localStorage`,
  `sessionStorage`, a cookie, or a DOM attribute. A page reload always
  requires a fresh login, matching the server's in-memory-only session
  model exactly.
- **Filesystem paths**: `buildInstanceSnapshot()` no longer forwards
  `readiness.probes` (which can carry a resolved executable path) into the
  snapshot at all — the data simply is not present for the client to
  render, structural containment rather than a display-layer filter.
  `describeReadiness()` in `agents-dashboard-view.mjs` independently never
  reads a `probes[].detail` even where it might otherwise be reachable in a
  test fixture, and a unit test asserts this.
- **Prompts / raw model output**: this dashboard has no view, field, or
  endpoint for either — the `/api/*` surface it consumes never returns them
  (see `docs/ops/AGENT-RUNNER-CONTROL-API.md`), so there is no code path
  for either to reach the DOM.
- **Browser storage**: neither `agents-dashboard.js` nor
  `agents-dashboard-view.mjs` calls `localStorage`/`sessionStorage`/
  `document.cookie = ...` anywhere;
  `agent-runner-control-static.test.mjs` asserts this by pattern match
  against the shipped file contents as a defense-in-depth regression
  guard.
- **Logs/console**: no client-side code path logs a credential value or
  CSRF token; the existing server-side "no route ever logs a request body"
  contract from #46 is unchanged.

## UX and accessibility

- Visually consistent with the existing static dashboard's monochrome
  design tokens (same color variables, panel/table conventions, dark-mode
  media query).
- All controls are real `<button>`/`<input>`/`<label>`/`<select>` elements
  with associated labels — no click-only `<div>` controls — and use
  `:focus-visible` styling for keyboard navigation. Status/error messages
  use `role="status"`/`role="alert"` for assistive-technology
  announcement.
- Responsive: the instance grid and two-column panels collapse to a single
  column under ~820px; base font size and table padding scale down under
  ~520px (mirroring the existing dashboard's breakpoints).
- The paid-agent enable confirmation is a real in-page `role="alertdialog"`
  panel, not a native `window.confirm()` — this keeps it keyboard-navigable
  and consistent with the rest of the UI (a native dialog would also block
  further automation in headless/browser-driven contexts).

## Known limitations

- "Adapter, command/runtime and safe version" reports an honest **version
  policy** label, not a live-probed version number — this control service's
  readiness check is a deterministic, zero-process-spawn PATH check by
  design (see `docs/ops/AGENT-RUNNER-CONTROL-API.md`), and this issue does
  not add a version probe.
- "Context/output limits" is reported as "not modeled by this adapter's
  control surface" for every adapter — no such field exists anywhere in
  this runner today; inventing one was out of scope.
- "Reserved work and assigned queue" collapses to the existing single
  global serial execution slot (`instance.load`) — this runner has no
  multi-worker queue-assignment model to report (see AGENTS.md: no
  concurrency, no routing).
- Manual, real-browser verification (DOM/localStorage/sessionStorage
  inspection via an interactive Chrome session) was not performed as part
  of this change, because the development sandbox's loopback network is
  not reachable from the reviewing browser session. Node-level integration
  tests exercise the full HTTP surface (login, CSRF, origin, create,
  configure, enable, credential write-only round-trip, drain, audit,
  rollback) end to end, and the shipped client source was reviewed and
  pattern-tested for the DOM/storage-leak properties described above.
  A local operator can additionally verify interactively per "Running it"
  below.

## Running it

Identical to #46, since this dashboard is served by the same process:

```bash
node -e "
import('./scripts/ops/agent-runner-control-auth.mjs').then(({ setOperatorCredential }) => {
  setOperatorCredential({ username: 'operator', password: 'a-strong-local-password-16+chars' });
});
"
node scripts/ops/agent-runner-control-server.mjs --port 8787
```

Then open `http://127.0.0.1:8787/` in a browser on the same machine. The
server refuses to bind to anything but loopback (see `resolveBindHost()`
in `agent-runner-control-server.mjs`) before a socket is ever opened.

## Validation

```bash
node --check scripts/ops/agent-runner-control-static.mjs \
  scripts/ops/agent-runner-control-instances.mjs \
  scripts/ops/agent-runner-control-readiness.mjs \
  scripts/ops/agent-runner-control-server.mjs \
  .agent-runner/agents-dashboard/agents-dashboard-view.mjs \
  .agent-runner/agents-dashboard/agents-dashboard.js

node --test scripts/ops/agent-runner-control-static.test.mjs \
  scripts/ops/agent-runner-agents-dashboard-view.test.mjs \
  scripts/ops/agent-runner-control-instances.test.mjs \
  scripts/ops/agent-runner-control-readiness.test.mjs \
  scripts/ops/agent-runner-control-server.test.mjs

npm test
npm run validate
git diff --check
```
