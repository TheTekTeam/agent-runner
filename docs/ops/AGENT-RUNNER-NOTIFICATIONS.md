# Agent Runner notifications (#53)

Durable, agent-agnostic operator notifications for meaningful Agent Runner
transitions, without coupling the contract to Claude or any specific
provider. Implements the MVP scoped by issue #53 under parent #41, hardened
per manager review rounds 2, 3 and 4 on PR #66.

## Delivery guarantee

**At-least-once, with `dedupe_key` doubling as a stable idempotency key
handed to the transport (as `idempotencyKey`) across every retry and
restart.**

This is explicitly **not** exactly-once, and explicitly **not** "exactly one
resend". Repeated crashes or timeouts between a transport call and the
corresponding SQLite write landing may cause **one or more duplicate
delivery attempts**, always carrying the same `idempotencyKey`. Each
crash-abandoned claim is *requeued* rather than charged against the bounded
delivery-attempt budget (see the stale-claim rules below), so the number of
duplicates is bounded by how often a process dies mid-delivery — not by any
count this module can promise in advance.

Collapsing those duplicate attempts into a single external side effect is
the transport/provider's responsibility (idempotent delivery keyed on
`idempotencyKey`), not a property this module can prove on its own.

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
replaced by its own sha256 hash — never arbitrary source text. A
`recovery_attempts`-sourced `failed_attention` row persists the bare
`attempt_id` as its `source_ref` (the `failed:` discriminator lives on the
dedupe key alone, which is the only place it was needed — to keep the row
distinct from the same attempt's `completed` notification), so the resolver
can perform a targeted primary-key lookup and the row can actually resolve.

### Not creating misleading notifications

A stateful candidate (`failed_attention`, `quota_blocked`, `systemic_pause`)
whose source condition is **already resolved at discovery time** is never
created at all — not created-then-immediately-resolved. One-shot event
types (`completed`, `agent_reassigned`, `no_qualified_agent`) always create
and resolve in the same delivery write, since there is no further
"unresolved" concept for them.

### Revalidating stateful source truth before delivery

A source condition can clear *after* a notification is created but *before*
it is delivered — a transport is disabled for days, or a row waits through
several retry backoffs. Every stateful row is therefore revalidated against
live source truth immediately after it is claimed and immediately before the
transport is invoked. If the condition has cleared, the row is resolved in
place: no delivery, no attempt consumed, no stale alert.

The same revalidation runs as a separate sweep over **every** unresolved
stateful row, whatever delivery stage it reached — `pending`,
`retryable-failed`, `delivered` or `exhausted`
(`unresolvedStatefulNotificationEvents()`). Restricting this sweep to
`delivered` rows left two live defects: a stale alert could still be
delivered later, and an *exhausted* `quota_blocked` row stayed unresolved
forever, so the `openNotificationExists()` occurrence gate suppressed every
future quota-blocked episode for that repository. One-shot rows are excluded
from this path in SQL, not merely by caller discipline
(`resolveStatefulNotificationEvent()`).

An unparseable or unrecognized `source_ref` fails **closed** — "not proven
cleared" — so an attention or systemic-pause alert stays visible rather than
being silently retired. The only event type where a permanently-unresolved
row could suppress later notifications is `quota_blocked`, and its
resolution branch does not parse `source_ref` at all: it re-reads live quota
truth for the repository.

#### A source-truth read failure is fail-closed

`createStateRecorder().invoke()` converts a state-store exception into
`null` **and** flips `state.healthy` false. That `null` is not source truth
and must never be read as one: for the attention and recovery branches it
would look like "still unresolved" (delivery would proceed), and for the
health and quota branches like "source cleared" (the row would be resolved).
Both readings are guesses about state nobody actually observed.

The pass therefore **stops immediately** after any source-truth lookup makes
the state unhealthy — before the pre-delivery revalidation decides anything,
and again inside the resolution sweep. On that path there is **no transport
call and no resolution**, no summary counter moves, and the failure stays in
`state.errors` (which gates `healthy` and the caller's systemic pause)
rather than being downgraded into a task-local `taskErrors` entry. A row
already claimed simply remains `in-flight` and is picked up by the ordinary
stale-claim recovery path, which requeues it without consuming an attempt.

### No double notification for the same task failure

A `recovery_attempts` row carrying an `attention_dedupe_key` defers entirely
to the `attention_events`-sourced candidate; the `recovery_attempts`-sourced
`failed_attention` path only fires when there is no attention tracking at
all **and** no further automatic-retry eligibility (`recovery_eligible`
false). A `recovery_attempts` row that might still retry, or is not yet
`finished_at`, holds cursor advancement at its own position (see below)
rather than being skipped permanently — the same row is reused in place
across its own retry lifecycle, so a later in-place update (retries
exhausted) is never missed. It does **not** stop later independent rows from
being processed.

### Routing events: only a proven mutation

A `routing_events` row may announce a reassignment or no-qualified-agent
outcome only when its `delivery_status` is an **exact** match for one of the
proven-applied statuses defined by the #50 routing contract:
`evidence-pending` or `resolved`. This is a positive allowlist, not a
`!== 'mutation-pending'` exclusion — a corrupt, empty, `NULL`, legacy or
future status must fail closed rather than announce a reassignment that may
never have happened.

Any non-proven status holds the cursor at that row (not a permanent skip),
so it is re-evaluated once the existing #50 reconciliation flow proves the
mutation applied. A status outside the *known* #50 vocabulary
(`mutation-pending`, `evidence-pending`, `resolved`) additionally records a
bounded local diagnostic (`notification-source-status-unknown`, carrying
only a fixed reason code — never the raw status text).

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

## Activation-gated, bounded, two-frontier discovery

`attention_events`, `routing_events` and `recovery_attempts` are scanned via
**two durable frontiers**:

1. a monotonic high-water cursor per `(repo, source_table)`
   (`notification_source_cursors`), and
2. a durable set of undecided row identities
   (`notification_deferred_source_rows`), rechecked on its own bounded,
   rotating schedule.

On first activation for a pair, the high-water cursor is set to the current
tail of that table — deliberately skipping **all** pre-existing history in
one step, so deploying this outbox never floods notifications for years of
already-settled data, and deferring none of it. Every later pass reads only
a bounded batch (default 25, configurable, clamped to `[1, 200]`) strictly
past the cursor. The cursor advances across every row the pass actually
evaluated, including undecided ones — but never past a row whose durable
write (its outbox intent, or its deferral record) failed, so a mid-batch
store failure resumes correctly rather than silently skipping the
remainder.

`recovery_attempts` is cursored on its SQLite **`rowid`**, not on
`started_at`. A timestamp cursor (`started_at > ?`) silently dropped any
genuinely new attempt sharing the boundary millisecond — attempt timestamps
are generated by this runner rather than by wall-clock chance, so that is
entirely reachable, and the dropped row would never have been notified at
all. `rowid` is unique, strictly increasing per insert, and unaffected by
the in-place `UPDATE`s `recordRecoveryAttempt()` performs on an existing
`attempt_id`. `attention_events` and `routing_events` cursor on their own
integer `id`. A stored cursor whose shape none of these understands (a
pre-round-3 timestamp cursor) is re-activated past the current tail rather
than trusted or replayed.

### An undecided row never blocks later rows, at any backlog length

A row whose fate is not yet final (still running, might still retry, or a
mutation not yet proven applied) is recorded in
`notification_deferred_source_rows` under the source table's own monotonic
integer identity — `id` for `attention_events`/`routing_events`, `rowid` for
`recovery_attempts`, never source text. The high-water cursor then moves
past it, so later rows keep flowing.

Each pass rechecks a bounded batch of deferred identities first,
least-recently-checked first, via targeted by-row-key lookups
(`attentionEventsByIds`, `routingEventsByIds`, `recoveryAttemptsByRowIds`).
A row that is still undecided is *touched*, moving it to the back of the
rotation so one permanently-stuck row cannot monopolise the recheck budget.
A row that has become final persists its outbox intent and is only then
dropped from the deferred set — so a crash between those two writes simply
rechecks it next pass, and `dedupe_key` makes the re-persist an exact no-op.
The result is **exactly one** notification for a row that was blocked for
any number of passes. A deferred row whose source row no longer exists at
all is dropped: there is no fate left to wait for.

Two earlier designs failed here. Round 2 stopped the scan at the first
undecided row, making every later row in that source table invisible for as
long as it stayed undecided. Round 3 kept scanning later rows but parked the
single durable cursor before the undecided one — which only worked inside
the batch window that pass happened to fetch: with a blocked **first** row
and more than `batchSize - 1` later rows, every pass refetched the identical
window and nothing beyond it was ever reached. Both are head-of-line
blocking on an outbox whose entire purpose is not losing events; the
two-frontier design holds across an arbitrarily long bounded backlog, with
no unbounded query, no growing in-memory list, and no permanently skipped
row.

`quota_history` and `runner_health_conditions` are deliberately **not**
cursor sources (see above) — both are scanned directly every pass, which is
safe because each only ever inspects a small, bounded amount of current
state (the single latest row; at most one row per known condition type),
never the full history.

### Every bound is a SQL bound

No stage loads a table and then limits, filters or slices it in JavaScript.
Due rows (`dueNotificationEvents`), the unresolved-stateful rescan
(`unresolvedStatefulNotificationEvents`), the deferred-row recheck
(`deferredNotificationSourceRows`), stale in-flight selection
(`reconcileStaleInFlightNotifications`, oldest claim first) and each cursor
batch all carry an explicit SQL `LIMIT`; health discovery queries only the closed
`HEALTH_CONDITION_REASON_CODES` condition types, still-open, with a `LIMIT`
(`openHealthConditionsForTypes`), rather than loading every historical or
unknown health row. Source-truth revalidation uses targeted single-row,
index-served lookups keyed on the notification's own persisted `source_ref`
(`attentionEventByDedupeKey`, `recoveryAttemptByAttemptId`,
`healthConditionForType`, `latestQuotaHistoryForRepo`) — never a repeated
`allRows(<table>)` full scan per notification. A large outbox or a long
history therefore cannot cause unbounded query or memory work while the
serial scheduler lock is held.

### The resolution sweep is fair

The unresolved-stateful rescan walks a **durable rotating cursor** over
`notification_events.id` (`notification_resolution_cursors`), advancing past
each checked batch and wrapping back to the start once the tail is reached.

Ordering that sweep oldest-first by `created_at` under a fixed `LIMIT` — the
round-3 behaviour — meant a permanently-open set of older attention or
systemic rows larger than one batch occupied every single sweep forever. A
newer cleared or *exhausted* `quota_blocked` row was then never rechecked,
stayed unresolved, and kept the `openNotificationExists()` occurrence gate
suppressing every later quota-blocked episode for that repository.

With rotation, every unresolved row of every stateful event type — quota,
attention and systemic alike — receives a bounded recurring check within
`ceil(unresolved / batchSize)` passes; no fixed group can starve another;
the progress survives restart/reopen; one-shot rows remain excluded in SQL;
and no query is unbounded.

Stale in-flight recovery is fair by construction rather than by cursor:
every recovered row leaves `in-flight`, so the next pass's identical
oldest-claim-first bounded query naturally picks up the next window until a
crash backlog of any size is drained.

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
`resolved` (schema v16; `event_type`, `reason_code`, `source_table`,
`last_error`, `attempt_count`, `max_attempts` and `stale_recovery_count` are
all CHECK-constrained too, and `project` is length-bounded). A due row is atomically
**claimed** into `in-flight` (with an owner and claim timestamp) immediately
before a transport is invoked — the crash-safe ownership boundary. A
disabled/paused transport (`{ paused: true }`) reverts a claimed row back to
`pending` untouched — no attempt consumed, no error, no scheduled retry —
so it remains deliverable indefinitely once a real transport is later
enabled. A genuine non-retryable rejection (`{ ok: false, retryable: false
}`) moves directly to `exhausted` in that one call, never passing through
`retryable-failed` first.

### Stale in-flight claims are requeued, never charged

A row still `in-flight` past a staleness bound (default 5 minutes) was
claimed by a process that never came back. It is reconciled onto the
**same** row/dedupe_key — never a new notification identity — because the
external side effect may already have happened, and only the same
idempotency key lets a real transport's provider-side dedupe collapse the
eventual resend. This is exactly why the delivery guarantee above is
at-least-once with possible duplicates, not exactly-once.

Such a claim is **requeued, not charged**: the row returns to `pending` and
is immediately due again, and `attempt_count` is left untouched. An
ambiguous stale claim is not equivalent to a proven transport rejection or
timeout — the process may well have died before the transport was ever
reached. Charging it (the round-2 behaviour) meant a process crash-looping
before its first transport call could silently walk an undelivered event all
the way to `exhausted` and discard it permanently. Stale recoveries are
instead counted in their own `stale_recovery_count` column, so a
repeatedly-abandoned row stays visible to an operator without ever becoming
undeliverable. Only a *proven* transport outcome
(`markNotificationDeliveryFailed`) consumes the bounded delivery-attempt
budget.

### The sink enforces its own bounds

`notification_events` is bounded by the state-store methods themselves, not
only by this module's callers: `source_table` is a closed set (an
unrecognized value is rejected outright), `project` is coerced to `NULL`
unless it matches a short bounded identifier shape (it is dashboard-visible),
and `last_error` is restricted to the closed `NOTIFICATION_ERROR_CODES`
vocabulary — anything else becomes the fixed `invalid-error-code` sentinel
rather than truncated raw text. Adversarial direct-store tests cover all
three, so a future caller cannot persist raw diagnostics through these
public methods.

Every conditional SQLite transition's return value is checked before a
pass's summary counts a delivery/resolution as successful; an unproven
write (e.g. a transport reporting success while the corresponding state
transition did not apply) is recorded as a fixed local diagnostic
(`state-transition-mismatch`) and never silently counted as delivered.

## Bounded delivery, never starving the serial execution lock

`reconcileNotifications()` is called at most once per `--execute` scheduler
pass from `claude-runner-cron.mjs::main()` — a single bounded notification-
reconciliation budget, not one call per admission path. The call site sits
immediately after the current pass's `quota_history` row is durably
recorded, but before three things that could otherwise hide a required
notification: the quota-blocked early return, this pass's resolution of any
prior open `systemic_pause` health condition, and process-identity capture
(itself an early-return admission gate on failure). This ordering is load-
bearing (#53 manager review round 5): a genuinely blocked quota pass must
create/observe its `quota_blocked` notification before it returns, and a
still-open `systemic_pause` from a prior pass — including one reopened by a
repeatable early fault such as process-identity capture failing every pass —
must be visible to reconciliation before this pass resolves or replaces it.
`main()` checks `state.healthy` immediately after this call; if the
reconciliation itself surfaced a genuine durable-state failure (as opposed
to a task-local fault, which never flips `state.healthy`), the pass stops
via the existing systemic-pause path rather than continuing admission on
unhealthy state. There is exactly one call site — no later duplicate call
during routing/recovery reconciliation. Every delivery attempt races against
a bounded per-call timeout
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
`delivery_status`, `attempt_count`, `max_attempts`, `stale_recovery_count`,
`next_attempt_at`, `last_attempt_at`, `delivered_at`, `resolved_at`.
`stale_recovery_count` is included deliberately: stale-claim recoveries no
longer consume `attempt_count`, so it is the only operator-visible signal
that a row keeps being abandoned mid-delivery. `dedupe_key`,
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
