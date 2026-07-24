#!/usr/bin/env node
/**
 * Agent-agnostic durable notification/outbox layer (#53).
 *
 * This module never talks to a real transport. It consumes only already-
 * durable, normalized runner state (recovery_attempts, attention_events,
 * quota_history, routing_events, runner_health_conditions -- all persisted
 * elsewhere by claude-runner-cron.mjs/claude-runner-state.mjs) and turns it
 * into a small, restart-safe outbox: `notification_events` rows moving
 * through pending -> delivered|retryable-failed -> exhausted|resolved.
 *
 * Every notification's content is built from a closed, bounded vocabulary
 * (event type, reason code, repo, issue number, agent id, occurrence
 * timestamp) -- never from prompts, provider output, raw logs/payloads,
 * comments, branch names or arbitrary labels. The default transport is
 * disabled and makes no call whatsoever; only tests may inject a synthetic
 * capture transport (see `createSyntheticNotificationTransport`).
 */

export const NOTIFICATION_STATE_SCHEMA_VERSION = 1;

export const NOTIFICATION_EVENT_TYPES = Object.freeze([
  'completed',
  'failed_attention',
  'quota_blocked',
  'agent_reassigned',
  'no_qualified_agent',
  'systemic_pause',
]);

// One-shot: there is no further "unresolved" concept once delivered -- the
// row resolves in the same write as delivery. Everything else is stateful:
// it stays 'delivered' (visible, undelivered-attention-safe) until this
// module observes -- on a later pass -- that the underlying durable source
// condition itself cleared.
const ONE_SHOT_EVENT_TYPES = new Set(['completed', 'agent_reassigned', 'no_qualified_agent']);

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BACKOFF_MS = 5 * 60_000;

const AGENT_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function sanitizeAgentId(value) {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value) ? value : null;
}

function isoNow() {
  return new Date().toISOString();
}

function addMs(isoTimestamp, ms) {
  const parsed = Date.parse(isoTimestamp);
  return new Date((Number.isFinite(parsed) ? parsed : Date.now()) + ms).toISOString();
}

/**
 * The only fields a notification's content may ever carry -- a positive
 * allowlist, built here rather than passed through from any source row.
 * Adding a new source field to an upstream table never changes this shape
 * unless this function is explicitly extended.
 */
export function buildNotificationContent({ eventType, reasonCode, repo, issueNumber = null, agent = null, occurredAt }) {
  return {
    eventType,
    reasonCode,
    repo,
    issueNumber: Number.isInteger(issueNumber) ? issueNumber : null,
    agent: sanitizeAgentId(agent),
    occurredAt,
  };
}

function candidate({ eventType, reasonCode, repo, project = null, issueNumber = null, agent = null, occurredAt, sourceTable, sourceRef, dedupeKey, sourceResolved }) {
  return {
    eventType,
    reasonCode,
    repo,
    project,
    issueNumber,
    agent: sanitizeAgentId(agent),
    occurredAt,
    sourceTable,
    sourceRef,
    dedupeKey,
    sourceResolved,
  };
}

function completedCandidates(rows = [], repo) {
  return rows
    .filter((row) => row.repo === repo && row.outcome === 'completed')
    .map((row) => candidate({
      eventType: 'completed',
      reasonCode: 'run-completed',
      repo,
      project: row.project || null,
      issueNumber: row.issue_number,
      agent: row.agent,
      occurredAt: row.finished_at || row.started_at,
      sourceTable: 'recovery_attempts',
      sourceRef: row.attempt_id,
      dedupeKey: `completed:${row.attempt_id}`,
      sourceResolved: true,
    }));
}

function attentionCandidates(rows = [], repo) {
  return rows
    .filter((row) => row.repo === repo)
    .map((row) => candidate({
      eventType: 'failed_attention',
      reasonCode: 'attention-required',
      repo,
      project: row.project || null,
      issueNumber: row.issue_number,
      agent: row.agent,
      occurredAt: row.started_at || row.created_at,
      sourceTable: 'attention_events',
      sourceRef: row.dedupe_key,
      dedupeKey: `attention:${row.dedupe_key}`,
      sourceResolved: Boolean(row.resolved_at),
    }));
}

function latestQuotaBlockedCandidate(rows = [], repo) {
  const latest = rows.find((row) => row.repo === repo);
  if (!latest || !latest.blocked) return null;
  const resetRef = latest.reset_at || 'unspecified';
  return candidate({
    eventType: 'quota_blocked',
    reasonCode: 'quota-or-paid-use-blocked',
    repo,
    issueNumber: null,
    agent: null,
    occurredAt: latest.created_at,
    sourceTable: 'quota_history',
    sourceRef: resetRef,
    dedupeKey: `quota:${repo}:${resetRef}`,
    sourceResolved: false,
  });
}

function routingCandidates(rows = [], repo) {
  return rows
    .filter((row) => row.repo === repo && (row.event_type === 'reassignment' || row.event_type === 'no-qualified-agent'))
    .map((row) => candidate({
      eventType: row.event_type === 'reassignment' ? 'agent_reassigned' : 'no_qualified_agent',
      reasonCode: row.event_type === 'reassignment' ? 'agent-disabled-reassigned' : 'no-qualified-agent',
      repo,
      issueNumber: row.issue_number,
      agent: row.event_type === 'reassignment' ? row.to_agent_id : null,
      occurredAt: row.created_at,
      sourceTable: 'routing_events',
      sourceRef: row.dedupe_key,
      dedupeKey: `routing:${row.dedupe_key}`,
      sourceResolved: true,
    }));
}

function healthConditionCandidates(rows = [], repo) {
  return rows
    .filter((row) => row.repo === repo)
    .map((row) => candidate({
      eventType: 'systemic_pause',
      reasonCode: row.condition_type === 'systemic_pause' ? 'systemic-pause' : 'control-service-failure',
      repo,
      issueNumber: null,
      agent: null,
      occurredAt: row.opened_at,
      sourceTable: 'runner_health_conditions',
      sourceRef: `${row.condition_type}:${row.opened_at}`,
      dedupeKey: `systemic:${repo}:${row.condition_type}:${row.opened_at}`,
      sourceResolved: Boolean(row.resolved_at),
    }));
}

/**
 * Read only already-durable normalized tables (via the same `state.invoke`
 * generic accessors claude-runner-cron.mjs already uses for
 * recovery_attempts/routing_events elsewhere) and turn them into candidate
 * notifications. Never reads queue_events/run_results payload_json, comment
 * bodies, prompts or provider output.
 */
export function discoverNotificationCandidates({ state, repo }) {
  const recoveryAttempts = state.invoke('allRows', 'recovery_attempts') || [];
  const attentionEvents = state.invoke('allRows', 'attention_events') || [];
  const quotaHistory = state.invoke('latestRows', 'quota_history', 1) || [];
  const routingEvents = state.invoke('allRows', 'routing_events') || [];
  const healthConditions = state.invoke('allRows', 'runner_health_conditions') || [];

  const quotaCandidate = latestQuotaBlockedCandidate(quotaHistory, repo);

  return [
    ...completedCandidates(recoveryAttempts, repo),
    ...attentionCandidates(attentionEvents, repo),
    ...(quotaCandidate ? [quotaCandidate] : []),
    ...routingCandidates(routingEvents, repo),
    ...healthConditionCandidates(healthConditions, repo),
  ];
}

/**
 * Disabled by default (#53: "keep all delivery transports disabled by
 * default" / "do not send a real email, webhook, Slack message, SMS, push
 * notification or provider request under this packet"). Makes no network
 * call, no filesystem write, no process spawn -- returns a bounded,
 * non-retryable-looking refusal so the outbox row simply stays pending
 * until an operator wires a real transport in a future, separately
 * authorized packet.
 */
export function createDisabledNotificationTransport() {
  return async function disabledNotificationTransport() {
    return { ok: false, retryable: false, reason: 'transport-disabled' };
  };
}

/**
 * Test-only synthetic capture transport (#53: "use dependency-injected
 * synthetic notification delivery during tests. Do not send a real email,
 * webhook, Slack message, SMS, push notification or provider request").
 * Captures each delivered notification's bounded content in-memory; never
 * performs any real I/O.
 */
export function createSyntheticNotificationTransport({ fail = () => false, retryable = true } = {}) {
  const deliveries = [];
  const attempts = [];
  const transport = async (notification) => {
    attempts.push(notification);
    if (fail(notification, attempts.length)) {
      return { ok: false, retryable, reason: 'synthetic-failure-injected' };
    }
    deliveries.push(notification);
    return { ok: true };
  };
  return { transport, deliveries, attempts };
}

function isSourceResolvedNow({ candidateRow, state, repo }) {
  if (ONE_SHOT_EVENT_TYPES.has(candidateRow.event_type)) return true;
  if (candidateRow.event_type === 'failed_attention') {
    const row = (state.invoke('allRows', 'attention_events') || []).find((item) => item.dedupe_key === candidateRow.source_ref);
    return Boolean(row?.resolved_at);
  }
  if (candidateRow.event_type === 'systemic_pause') {
    const [conditionType] = String(candidateRow.source_ref || '').split(':');
    const row = (state.invoke('currentHealthConditions', repo) || []).find((item) => item.condition_type === conditionType);
    return !row; // no longer present among *current* (unresolved) conditions
  }
  if (candidateRow.event_type === 'quota_blocked') {
    const latest = (state.invoke('latestRows', 'quota_history', 1) || [])[0];
    if (!latest) return false;
    return !latest.blocked || latest.reset_at !== candidateRow.source_ref;
  }
  return true;
}

/**
 * The full reconciliation pass: discover candidates from durable source
 * tables, persist pending intent for any genuinely new occurrence
 * (dedupe_key UNIQUE makes repeated passes over the same occurrence a
 * no-op), attempt delivery for anything due, and recheck already-delivered
 * stateful rows for source resolution. Mirrors
 * `reconcilePendingRoutingEvents()`'s shape and never throws: every
 * per-row failure is caught and recorded via `state.recordTaskError`, so a
 * notification-local fault can never propagate into the caller's queue/
 * claim/run/routing/recovery state or its serial lock lifecycle.
 */
export async function reconcileNotifications({
  state, args, transport = createDisabledNotificationTransport(), now = isoNow, retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const summary = { discovered: 0, inserted: 0, delivered: 0, retried: 0, exhausted: 0, resolved: 0 };
  if (!state.healthy) return summary;
  const repo = args.repo;

  let candidates = [];
  try {
    candidates = discoverNotificationCandidates({ state, repo });
  } catch (error) {
    state.recordTaskError('notification-discovery-failed', error);
    return summary;
  }
  summary.discovered = candidates.length;

  for (const item of candidates) {
    const content = buildNotificationContent(item);
    const recorded = state.invoke('recordNotificationEvent', {
      repo: item.repo,
      project: item.project,
      issueNumber: item.issueNumber,
      eventType: item.eventType,
      reasonCode: item.reasonCode,
      agent: item.agent,
      sourceTable: item.sourceTable,
      sourceRef: item.sourceRef,
      occurredAt: item.occurredAt,
      dedupeKey: item.dedupeKey,
      content,
      maxAttempts,
    });
    if (recorded?.inserted) summary.inserted += 1;
  }

  if (!state.healthy) return summary;

  const due = state.invoke('dueNotificationEvents', repo, now()) || [];
  for (const row of due) {
    let content;
    try {
      content = JSON.parse(row.content_json || '{}');
    } catch {
      content = buildNotificationContent({
        eventType: row.event_type, reasonCode: row.reason_code, repo: row.repo, issueNumber: row.issue_number, agent: row.agent, occurredAt: row.occurred_at,
      });
    }
    let outcome;
    try {
      outcome = await transport(content);
    } catch (error) {
      state.recordTaskError('notification-delivery-threw', error);
      outcome = { ok: false, retryable: true, reason: 'transport-threw' };
    }
    if (outcome?.ok) {
      const resolveNow = ONE_SHOT_EVENT_TYPES.has(row.event_type);
      state.invoke('markNotificationDelivered', { dedupeKey: row.dedupe_key, deliveredAt: now(), resolveNow });
      summary.delivered += 1;
      if (resolveNow) summary.resolved += 1;
      continue;
    }
    const result = state.invoke('markNotificationDeliveryFailed', {
      dedupeKey: row.dedupe_key,
      attemptedAt: now(),
      error: outcome?.reason || 'delivery-failed',
      nextAttemptAt: addMs(now(), retryBackoffMs),
    });
    if (result?.exhausted) summary.exhausted += 1;
    else summary.retried += 1;
  }

  if (!state.healthy) return summary;

  const deliveredUnresolved = state.invoke('deliveredUnresolvedNotificationEvents', repo) || [];
  for (const row of deliveredUnresolved) {
    let resolvedNow = false;
    try {
      resolvedNow = isSourceResolvedNow({ candidateRow: row, state, repo });
    } catch (error) {
      state.recordTaskError('notification-resolution-check-failed', error);
      continue;
    }
    if (resolvedNow) {
      state.invoke('resolveNotificationEvent', { dedupeKey: row.dedupe_key, resolvedAt: now() });
      summary.resolved += 1;
    }
  }

  return summary;
}
