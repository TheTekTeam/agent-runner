# Agent Runner notifications (#53)

Durable, agent-agnostic operator notifications for meaningful Agent Runner
transitions, without coupling the contract to Claude or any specific
provider. Implements the MVP scoped by issue #53 under parent #41, hardened
per manager review round 2 on PR #66.

## Delivery guarantee

**At-least-once, with `dedupe_key` doubling as a stable idempotency key
handed to the transport (as `idempotencyKey`) across every retry and
restart.** This is explicitly **not** exactly-once: a crash between a
transport call succeeding and the corresponding SQLite write landing causes
exactly one resend on the next reconciliation pass, using the identical
idempotency key. Collapsing that resend into a no-op is the transport/
provider's responsibility (idempotent delivery keyed on `idempotencyKey`),
not a property this module can prove on its own.

## Source of truth

`scripts/ops/agent-runner-notifications.mjs` consumes only already-durable,
normalized runner state persisted elsewhere (`claude-runner-state.mjs`),
never prompts, provider output, raw logs/payloads, GitHub comments, branch
names or arbitrary labels:

| MVP state | Durable source | Notes |
| --- | --- | --- |
| `completed` | `recovery_attempts` (`outcome = 'completed'`) | one-shot; cursor-scanned |
| `failed_attention` | `attention_events`, or `recovery_attempts` (closed `FAILURE_NOTIFY_OUTCOMES` set, no attention row, no further retry eligible) | stateful; cursor-scanned; deterministic precedence avoids double-notify |
| `quota_blocked` | `quota_history` (latest row **for this repo specifically**) | stateful; not cursor-scanned (see below) |
| `agent_reassigned` | `routing_events` (`event_type = 'reassignment'`, mutation proven applied) | one-shot; cursor-scanned |
| `no_qualified_agent` | `routing_events` (`event_type = 'no-qualified-agent'`) | one-shot; cursor-scanned |
| `systemic_pause` | `runner_health_conditions` (closed condition-type mapping) | stateful; scanned directly every pass, not cursor-scanned (see below) |

Every notification's content is rebuilt from a closed, bounded allowlist
(`buildNotificationContent()`): `eventType`, `reasonCode`, `repo`,
`issueNumber`, `agent` (a label-shaped id or `null`), `occurredAt`. This
validation runs both before persistence and again immediately before
delivery — a stored `content_json` blob is **never** trusted for delivery;
outbound content is always rebuilt from the row's own validated columns. A
`source_ref` is either a recognized bounded shape (a sha256 hex digest, a
`word:timestamp` pair, or a `repo#issue:timestamp` attempt id) or is itself
replaced by its own sha256 hash — never arbitrary source text.

### Not creating misleading notifications

A stateful candidate (`failed_attention`, `quota_blocked`, `systemic_pause`)
whose source condition is **already resolved at discovery time** is never
created at all — not created-then-immediately-resolved. One-shot event
types (`completed`, `agent_reassigned`, `no_qualified_agent`) always create
and resolve in the same delivery write, since there is no further
"unresolved" concept for them.

### No double notification for the same task failure

A `recovery_attempts` row carrying an `attention_dedupe_key` defers entirely
to the `attention_events`-sourced candidate; the `recovery_attempts`-sourced
`failed_attention` path only fires when there is no attention tracking at
all **and** no further automatic-retry eligibility (`recovery_eligible`
false). A `recovery_attempts` row that might still retry, or is not yet
`finished_at`, blocks cursor advancement (see below) rather than being
skipped permanently — the same row is reused in place across its own retry
lifecycle, so a later in-place update (retries exhausted) is never missed.

### Routing events: only a proven mutation

`routing_events` rows with `delivery_status = 'mutation-pending'` never
announce a reassignment or no-qualified-agent outcome — the GitHub label
mutation is not yet proven applied. Such a row blocks cursor advancement
(not a permanent skip) so it is re-evaluated once the existing #50
reconciliation flow proves the mutation applied (`evidence-pending` or
`resolved`).

### Quota: repository-scoped and occurrence-specific

Quota discovery reads `latestQuotaHistoryForRepo(repo)` — never a
globally-latest-row view later filtered by repo, which would let a
different repository's more recent poll hide or fabricate this repository's
own blocked/available status. Creation is gated on "no currently-open
`quota_blocked` notification already exists for this repo" (the occurrence
boundary itself), so a missing reset timestamp never collapses every future
blocked episode into one shared "unspecified" bucket.

### Systemic pause: exact episode matching

`runner_health_conditions` is upserted in place per `(repo, condition_type)`
— reopening an episode updates the same row rather than inserting a new
one — so it is **not** a cursor source (see below); it is scanned directly
every pass, bounded by there being at most one row per known condition type.
Only the closed `HEALTH_CONDITION_REASON_CODES` mapping (`systemic_pause`,
`queue_inspection_degraded`) is ever notified; every other condition type is
silently ignored, never defaulted to a generic bucket. Resolution matching
uses the row's exact captured `opened_at`: a later episode of the same
condition type neither falsely resolves nor permanently blocks an older
episode's notification.

## Activation-gated, bounded, cursor-based discovery

`attention_events`, `routing_events` and `recovery_attempts` are scanned via
a durable per-`(repo, source_table)` cursor (`notification_source_cursors`).
On first activation for a pair, the cursor is set to the current tail of
that table — deliberately skipping **all** pre-existing history in one
step, so deploying this outbox never floods notifications for years of
already-settled data. Every later pass reads only a bounded batch (default
25, configurable, clamped to `[1, 200]`) strictly past the cursor, and the
cursor only advances past a row once its outbox intent is durably
persisted — never blindly to the end of a fetched batch, and never past a
row whose fate is not yet final (still running, might still retry, or a
mutation not yet proven applied).

`quota_history` and `runner_health_conditions` are deliberately **not**
cursor sources (see above) — both are scanned directly every pass, which is
safe because each only ever inspects a small, bounded amount of current
state (the single latest row; at most one row per known condition type),
never the full history.

## Delivery state machine

```
pending --(claim)--> in-flight --(deliver ok)-->        delivered --(source cleared)--> resolved
                         |                                   ^
                         |--(deliver fails, retryable)--> retryable-failed --(claim)--> in-flight ...
                         |
                         |--(deliver fails, non-retryable, in ONE call)--> exhausted
                         |
                         `--(disabled/paused transport)--> pending  (unchanged: no attempt consumed)
```

`notification_events.delivery_status` is a CHECK-constrained closed set:
`pending`, `in-flight`, `delivered`, `retryable-failed`, `exhausted`,
`resolved` (schema v14; `event_type`, `reason_code`, `attempt_count` and
`max_attempts` are all CHECK-constrained too). A due row is atomically
**claimed** into `in-flight` (with an owner and claim timestamp) immediately
before a transport is invoked — the crash-safe ownership boundary. A
disabled/paused transport (`{ paused: true }`) reverts a claimed row back to
`pending` untouched — no attempt consumed, no error, no scheduled retry —
so it remains deliverable indefinitely once a real transport is later
enabled. A genuine non-retryable rejection (`{ ok: false, retryable: false
}`) moves directly to `exhausted` in that one call, never passing through
`retryable-failed` first. A rows still `in-flight` past a staleness bound
(default 5 minutes) is reconciled — onto the **same** row/dedupe_key, never
a new notification identity — on the assumption a prior process crashed
mid-delivery; the external side effect may already have happened, which is
exactly why the delivery guarantee above is at-least-once, not
exactly-once.

Every conditional SQLite transition's return value is checked before a
pass's summary counts a delivery/resolution as successful; an unproven
write (e.g. a transport reporting success while the corresponding state
transition did not apply) is recorded as a fixed local diagnostic
(`state-transition-mismatch`) and never silently counted as delivered.

## Bounded delivery, never starving the serial execution lock

`reconcileNotifications()` is called once per `--execute` scheduler pass
from `claude-runner-cron.mjs::main()`, before candidate selection, in the
same place and style as the existing `reconcilePendingRoutingEvents()`
call. Every delivery attempt races against a bounded per-call timeout
(default 5s, clamped `[100ms, 30s]`); the whole pass is additionally bounded
by a total duration budget (default 10s, clamped `[500ms, 60s]`). A hung,
rejected or throwing transport therefore can never hold delivery open
indefinitely or starve the next eligible engineering issue — ownership is
released (reverted to `retryable-failed`/`pending`, or handled by the next
pass's stale-in-flight reconciliation) and control returns to `main()`
promptly either way.

The function never throws: every per-row/per-stage fault (discovery,
delivery, resolution-check) is caught and recorded via
`state.recordTaskError()` using only a **fixed reason code** (never a raw
exception message or a transport's raw text) — see `DELIVERY_REASON_CODES`
— so a notification-local failure can never corrupt queue, claim, run,
routing or recovery state, and can never delay `main()`'s `finally` block
from releasing the serial lock (`unlock()`) or block the next eligible
candidate on the same or an immediately following pass.

## Delivery transport

The default transport (`createDisabledNotificationTransport()`) is disabled
by default: it makes no network call, filesystem write or process spawn,
and always reports `{ ok: false, paused: true, reasonCode:
'transport-disabled' }`. No real email, webhook, Slack message, SMS, push
notification or provider request is implemented by this packet. Only tests
inject a synthetic capture transport (`createSyntheticNotificationTransport()`)
that records delivered notifications (and the `idempotencyKey` each was
handed) in-memory.

## Dashboard/API exposure

`claude-runner-dashboard-api.mjs` exposes `notification_events` rows under
`latest.notifications`, through a positive-allowlist serializer (matching
the existing convention for `recovery_attempts`/`attention_events`/
`runner_health_conditions`): `id`, `created_at`, `updated_at`, `repo`,
`project`, `issue_number`, `event_type`, `reason_code`, `agent`,
`delivery_status`, `attempt_count`, `max_attempts`, `next_attempt_at`,
`last_attempt_at`, `delivered_at`, `resolved_at`. `dedupe_key`,
`source_table`, `source_ref`, `content_json`, `last_error`,
`in_flight_owner` and `in_flight_claimed_at` are deliberately excluded —
internal correlation/audit/ownership detail with no dashboard display
purpose. A new column added to the schema is excluded by default until
explicitly added to the allowlist.

Unresolved dashboard attention (`attention_events` with `resolved_at IS
NULL`, surfaced via `operatorStatus`) is entirely independent of
notification delivery outcome: a notification delivery failure never
touches `attention_events`, so the dashboard's unresolved-attention record
stays visible regardless of whether its corresponding notification
delivered, retried, paused, or exhausted its retries.

## Out of scope for this packet

- Any real delivery transport (email/webhook/Slack/SMS/push/provider API).
- Multi-agent routing changes, manager authority changes, or invoking
  Codex/Grok/Ollama.
- Timer enablement, deployment, or GitHub issue mutation as a notification
  side effect.
