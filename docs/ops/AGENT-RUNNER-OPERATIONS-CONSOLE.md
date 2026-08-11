# Standalone Agent Runner operations console (issue #175)

Status: **machine-local only — loopback-bound, authenticated, not wired
into any installer, systemd unit, timer, or LAN/public exposure.** This
raises the `#47` foundation dashboard into the permanent operations and
control surface described in `#175`. It is a client of `#46`'s control API
plus one new read-only route, and nothing more.

See `#41` for MVP sequencing, `#174` for the companion service work, `#1`
for the read-only observability exporter Grafana consumes, and
`TheTekTeam/dev-cluster-optimisation#36`/`#19` for the Grafana side.

## The five-second question set

An operator opening the page should be able to answer, without scrolling
or navigating:

1. is the runner healthy and is unattended execution enabled — the topbar
   state strip, visible in every section;
2. is it idle/running/paused/degraded/blocked/awaiting attention — the
   `runner` badge, which is never `healthy` when data is missing;
3. what is current, on which agent, for how long — the Current task card;
4. what is queued versus skipped and why — the Queue & admission tile with
   bounded reason codes and counts;
5. how much included quota/headroom remains — the Included quota tile;
6. which agents are enabled/ready/constrained/disabled/unsupported — the
   Agent fleet tile and the Agents section;
7. what happened recently — Recent activity, and the full Activity view;
8. is anything waiting on a human — the Attention badge and the "Requires
   operator action" list.

## Information architecture

One app shell, four sections, hash-routed (`#overview`, `#agents`,
`#activity`, `#settings`) so every view is linkable, bookmarkable and
reachable by keyboard.

- **Overview** (default) — current task, six operational tiles (scheduler,
  quota, queue, fleet, health/attention, runs), the operator-action list,
  recent activity, and the companion-surface links.
- **Agents** — a compact fleet table (state, readiness, model/profile,
  execution surface, cost class, load, last state change) with the detailed
  settings, write-only credential form and lifecycle controls moved into a
  focus-managed detail drawer, so they no longer occupy the first screen.
- **Activity** — runner activity and operator configuration changes merged
  into one chronological timeline, each row tagged with its `source` so the
  two are never confused. Filtering happens entirely over already-loaded
  bounded fields and never sends a query anywhere.
- **Settings & audit** — operator-safe service status, the control audit
  trail, and the settings revision/rollback controls, visually separated as
  "Advanced" and gated behind an in-page confirmation.

## Where the live state comes from

`GET /api/overview` only — see `AGENT-RUNNER-CONTROL-API.md` for the field
allowlist, the read-only proof, and why the projection is canonical by
construction (it composes the same read path and the same pure derivations
as the `status` CLI, with a parity test to keep them from diverging).

There is deliberately **no second runner model in the browser**. The client
formats what the projection sends and adds no independent opinion about
runner state. Two consequences worth naming:

- the queue summary reports skipped issues, skip reason codes and counts,
  but **not** a "runnable count" — nothing in the canonical projection
  proves how many issues are currently eligible, and inventing that number
  would be a fabrication. The UI says so explicitly;
- the current-task card distinguishes "actively running" from "awaiting
  human attention" using an unresolved attention event for the same issue,
  which is real evidence, rather than guessing from the absence of a
  terminal result.

## Status vocabulary

`healthy`, `idle`, `running`, `disabled`, `paused`, `draining`, `degraded`,
`blocked`, `attention`, `unavailable`, `unsupported`, `stale`, `unknown` —
defined once in `agent-runner-control-overview.mjs` and mirrored in
`agents-overview-view.mjs`, with a test asserting the two lists stay
byte-identical.

Rules the tests enforce:

- missing data is never rendered as `healthy`. An unreadable state database
  is `unavailable`; an uninspectable systemd is `unknown`; an installed,
  active timer with no poll in the last 45 minutes is `stale`;
- an `enabled` adapter whose readiness probe is failing is `unavailable`,
  never a green tick;
- every non-obvious status carries a human-readable explanation and, where
  one exists, the safe next operator action.

## Security properties preserved

All of `#45`/`#46`/`#47` holds unchanged, and is regression-tested:

- loopback-only bind, refused before `listen()`;
- authentication on every dynamic read and write, including the new
  overview route;
- strict origin/Referer checks and double-submit CSRF on mutations;
- HttpOnly `SameSite=Strict` session cookie; the CSRF token lives only in a
  module closure and is discarded on reload;
- **nothing is persisted in browser storage at all** — not even the theme
  choice, which is intentionally memory-only so the bundle contains no
  storage write of any kind;
- credentials remain write-only and the input clears synchronously, before
  the request settles;
- positive static-asset allowlist (now five literal filenames), strict CSP,
  `nosniff`, no arbitrary path serving;
- no external JS/CSS/font/CDN/telemetry dependency: the icon set is an
  inline repository-local SVG sprite, and a test asserts the only
  absolute-URL literal anywhere in the bundle is the SVG XML namespace;
- exactly one `fetch()` call site, same-origin and credentialed, only ever
  called with an `/api/…` path, and no other network channel
  (`XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`) anywhere.

## Performance

- no framework, no build step, no bundler;
- polling at 15s idle / 8s while a run is active, and **zero** work while
  the tab is hidden — the loop is torn down on `visibilitychange` and
  refreshes once immediately on return;
- server-side short-TTL memoisation of the overview read, so a polling tab
  cannot cause a systemd spawn plus a SQLite snapshot copy per request;
- no full DOM rebuild for a status change: text nodes are written only when
  the value actually differs, and fleet rows are keyed by agent id and
  reused across refreshes;
- the elapsed timer re-renders exactly one text node once a second while a
  run is active, and does not run otherwise;
- bounded payloads and a bounded in-browser timeline (80 rows), so repeated
  refreshes cannot grow memory without limit.

## Accessibility

Semantic landmarks (`banner`/`navigation`/`main`), a skip link, one `<h1>`
per view, real buttons/inputs with explicit `<label for>`, visible
`:focus-visible` outlines, a focus-trapped `role="dialog" aria-modal="true"`
drawer with Escape-to-close and focus restoration, scoped table headers with
captions, a stacked mobile alternative for the dense fleet table, `aria-live`
announcements that fire only on genuinely changed state, first-class light
and dark themes following the system preference with an explicit override,
`prefers-reduced-motion` support, and no colour-only status anywhere — every
badge renders a text label and a redundant glyph.

## Known limitations

- **Queue drill-down is summary-only.** The canonical projection exposes
  bounded skip reason codes and counts, not a per-issue queue listing, so
  the console shows counts and reasons rather than an issue-by-issue queue
  table. Adding one would need a new safe read path, not a new UI.
- **No runnable count**, for the reason given above.
- **Model/profile for the current task is only shown when recorded.** The
  runner persists the selected agent and assignment label on selections and
  recovery rows; there is no separate per-attempt model/profile record, so
  the card shows the agent and the configured model/profile of that agent
  rather than inventing a per-run value.
- **One global serial execution slot.** The Agents view states this
  honestly; nothing here changes concurrency, routing or billing semantics.
- **Scheduler staleness is a heuristic over the retained poll window** (45
  minutes). It is reported as `stale` — an explicit "this may be wrong"
  state — never as failure.
- **Field acceptance on the Dell has not been performed by this change.**
  The browser walkthrough, viewport checks, keyboard-only pass, theme
  checks and restart/session-invalidation proof in `#175`'s acceptance list
  remain to be run against the real service.

## Validation

```bash
node --check scripts/ops/agent-runner-control-overview.mjs
node --test scripts/ops/agent-runner-control-overview.test.mjs \
            scripts/ops/agent-runner-overview-view.test.mjs \
            scripts/ops/agent-runner-control-server.test.mjs \
            scripts/ops/agent-runner-control-static.test.mjs \
            scripts/ops/agent-runner-agents-dashboard-view.test.mjs
npm test
```
