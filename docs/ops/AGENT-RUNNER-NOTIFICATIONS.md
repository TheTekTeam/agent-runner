# Agent Runner notifications (#53)

Durable, agent-agnostic operator notifications for meaningful Agent Runner
transitions, without coupling the contract to Claude or any specific
provider. Implements the MVP scoped by issue #53 under parent #41.

## Source of truth

`scripts/ops/agent-runner-notifications.mjs` consumes only already-durable,
normalized runner state persisted elsewhere (`claude-runner-state.mjs`):

| MVP state | Durable source | Dedupe identity |
| --- | --- | --- |
| `completed` | `recovery_attempts` (`outcome = 'completed'`) | attempt id |
| `failed_attention` | `attention_events` | attention `dedupe_key` |
| `quota_blocked` | `quota_history` (latest row, `blocked = 1`) | reset window |
| `agent_reassigned` | `routing_events` (`event_type = 'reassignment'`) | routing `dedupe_key` |
| `no_qualified_agent` | `routing_events` (`event_type = 'no-qualified-agent'`) | routing `dedupe_key` |
| `systemic_pause` | `runner_health_conditions` | `(condition_type, opened_at)` |

It never derives content from prompts, provider output, raw logs/payloads,
GitHub comments, branch names or arbitrary labels. Every notification's
content is built by `buildNotificationContent()` from a closed, bounded
field set: `eventType`, `reasonCode`, `repo`, `issueNumber`, `agent` (a
label-shaped id or `null`), and `occurredAt`.

## Delivery state machine

Schema v13 of `claude-runner-state.mjs` adds one additive table,
`notification_events`, with a `dedupe_key` `UNIQUE` column. A dedupe
collision on a repeated reconciliation pass over the same durable
occurrence is a safe no-op; a genuinely new occurrence (a new attempt id,
attention/routing dedupe key, health-condition open episode, or quota reset
window) always carries a different key and always inserts.

```
pending --(deliver ok)--> delivered --(source cleared)--> resolved
   |                          ^
   |--(deliver fails, retry)--|
   |
   `--(attempts exhausted)--> exhausted
```

Intent (`pending`) is always persisted before any delivery attempt. One-shot
event types (`completed`, `agent_reassigned`, `no_qualified_agent`) resolve
in the same write as a successful delivery — there is no further
"unresolved" concept for them. Stateful event types (`failed_attention`,
`quota_blocked`, `systemic_pause`) stay `delivered` — remaining visible and
undelivered-attention-safe — until a later reconciliation pass observes that
the underlying durable source condition itself cleared.

`reconcileNotifications()` is called once per `--execute` scheduler pass
from `claude-runner-cron.mjs::main()`, in the same place and style as the
existing `reconcilePendingRoutingEvents()` call. It never throws: every
per-row fault (discovery, delivery, resolution-check) is caught and
recorded via `state.recordTaskError()`, exactly like the routing-event
reconciler, so a notification-local failure can never corrupt queue, claim,
run, routing or recovery state, and can never delay `main()`'s `finally`
block from releasing the serial lock (`unlock()`) or block the next
eligible candidate on a later pass.

## Delivery transport

The default transport (`createDisabledNotificationTransport()`) is disabled
by default: it makes no network call, filesystem write or process spawn,
and always reports `{ ok: false, retryable: false, reason:
'transport-disabled' }`. No real email, webhook, Slack message, SMS, push
notification or provider request is implemented by this packet. Only tests
inject a synthetic capture transport (`createSyntheticNotificationTransport()`)
that records delivered notifications in-memory.

## Dashboard/API exposure

`claude-runner-dashboard-api.mjs` exposes `notification_events` rows under
`latest.notifications`, through a positive-allowlist serializer (matching
the existing convention for `recovery_attempts`/`attention_events`/
`runner_health_conditions`): `id`, `created_at`, `updated_at`, `repo`,
`project`, `issue_number`, `event_type`, `reason_code`, `agent`,
`delivery_status`, `attempt_count`, `max_attempts`, `next_attempt_at`,
`last_attempt_at`, `delivered_at`, `resolved_at`. `dedupe_key`,
`source_table`, `source_ref`, `content_json` and `last_error` are
deliberately excluded — internal correlation/audit detail with no
dashboard display purpose. A new column added to the schema is excluded by
default until explicitly added to the allowlist.

Unresolved dashboard attention (`attention_events` with `resolved_at IS
NULL`, surfaced via `operatorStatus`) is entirely independent of
notification delivery outcome: a notification delivery failure never
touches `attention_events`, so the dashboard's unresolved-attention record
stays visible regardless of whether its corresponding notification
delivered, retried, or exhausted its retries.

## Out of scope for this packet

- Any real delivery transport (email/webhook/Slack/SMS/push/provider API).
- Multi-agent routing changes, manager authority changes, or invoking
  Codex/Grok/Ollama.
- Timer enablement, deployment, or GitHub issue mutation as a notification
  side effect.
