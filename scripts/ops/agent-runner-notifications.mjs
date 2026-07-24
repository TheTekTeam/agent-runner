#!/usr/bin/env node
/**
 * Agent-agnostic durable notification/outbox layer (#53).
 *
 * This module never talks to a real transport. It consumes only already-
 * durable, normalized runner state (recovery_attempts, attention_events,
 * quota_history, routing_events, runner_health_conditions -- all persisted
 * elsewhere by claude-runner-cron.mjs/claude-runner-state.mjs) and turns it
 * into a small, restart-safe outbox: `notification_events` rows moving
 * through pending -> in-flight -> delivered|retryable-failed ->
 * exhausted|resolved.
 *
 * Every notification's content is rebuilt from a closed, bounded vocabulary
 * (event type, reason code, repo, issue number, agent id, occurrence
 * timestamp) validated against the same allowlist both before persistence
 * and again immediately before delivery -- never trusted from a stored JSON
 * blob, and never derived from prompts, provider output, raw logs/payloads,
 * comments, branch names or arbitrary labels. The default transport is
 * disabled and makes no call whatsoever; only tests may inject a synthetic
 * capture transport (see `createSyntheticNotificationTransport`).
 *
 * DELIVERY GUARANTEE: at-least-once, with `dedupe_key` doubling as a stable
 * idempotency key handed to the transport across every retry and restart.
 * This is NOT exactly-once, and it is NOT "exactly one resend": repeated
 * crashes or timeouts between a transport call and the corresponding SQLite
 * write may cause ONE OR MORE duplicate delivery attempts, always carrying
 * the same `idempotencyKey`. Each crash-abandoned claim is requeued rather
 * than charged against the bounded delivery-attempt budget, so the number of
 * duplicates is bounded by how often the process dies mid-delivery, not by
 * any count this module can promise. Collapsing those duplicates into a
 * single external side effect is the transport/provider's responsibility
 * (idempotent delivery keyed on `idempotencyKey`), not a property this
 * module can prove on its own.
 */

import { createHash } from 'node:crypto';

import { TERMINAL_OUTCOMES } from './claude-runner-recovery.mjs';

export const NOTIFICATION_STATE_SCHEMA_VERSION = 4;

export const NOTIFICATION_EVENT_TYPES = Object.freeze([
  'completed',
  'failed_attention',
  'quota_blocked',
  'agent_reassigned',
  'no_qualified_agent',
  'systemic_pause',
]);

const REASON_CODES = Object.freeze([
  'run-completed',
  'attention-required',
  'quota-or-paid-use-blocked',
  'agent-disabled-reassigned',
  'no-qualified-agent',
  'systemic-pause',
  'control-service-failure',
]);

// Fixed, closed delivery-outcome reason codes -- the ONLY strings this
// module ever writes to `last_error` or hands to `state.recordTaskError()`.
// Never a raw transport `reason` string, never an exception's own message.
export const DELIVERY_REASON_CODES = Object.freeze([
  'transport-disabled',
  'transport-timeout',
  'transport-rejected-retryable',
  'transport-rejected-permanent',
  'transport-threw',
  'stale-in-flight-recovered',
  'state-transition-mismatch',
]);

/**
 * The closed set of `recovery_attempts.outcome` values that represent a
 * genuine task failure this module may ever notify about (#53 review, item
 * 3): every `TERMINAL_OUTCOMES` member except `completed` (its own,
 * separate event type) and `quota_paused` (covered by the quota_history-
 * derived `quota_blocked` event type instead, which is the scheduler-level
 * signal operators actually act on).
 */
export const FAILURE_NOTIFY_OUTCOMES = Object.freeze(TERMINAL_OUTCOMES.filter((outcome) => outcome !== 'completed' && outcome !== 'quota_paused'));

// Closed mapping (#53 review, item 3): only these exact runner_health_conditions
// condition types are ever notified. Any other/unrecognized condition type is
// silently ignored -- never defaulted to a generic bucket.
const HEALTH_CONDITION_REASON_CODES = Object.freeze({
  systemic_pause: 'systemic-pause',
  queue_inspection_degraded: 'control-service-failure',
});

const ONE_SHOT_EVENT_TYPES = new Set(['completed', 'agent_reassigned', 'no_qualified_agent']);

/** The stateful complement of ONE_SHOT_EVENT_TYPES -- the event types whose source condition persists after delivery and can later clear on its own. */
const STATEFUL_EVENT_TYPES = new Set(NOTIFICATION_EVENT_TYPES.filter((eventType) => !ONE_SHOT_EVENT_TYPES.has(eventType)));

/**
 * The exact `routing_events.delivery_status` values that prove the GitHub
 * label mutation behind a reassignment / no-qualified-agent decision was
 * actually applied, per the #50 routing contract (#53 review round 3, item
 * 6). This is a positive allowlist, not a `!== 'mutation-pending'`
 * exclusion: a corrupt, NULL, legacy or future status must fail closed and
 * stay revisitable, never announce a reassignment that may never have
 * happened.
 */
const ROUTING_PROVEN_DELIVERY_STATUSES = new Set(['evidence-pending', 'resolved']);

/** Statuses #50 is known to write. Anything outside this set is genuinely corrupt/unrecognized and worth a bounded local diagnostic; `mutation-pending` is simply not-yet-decided. */
const ROUTING_KNOWN_DELIVERY_STATUSES = new Set(['mutation-pending', 'evidence-pending', 'resolved']);

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BACKOFF_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PASS_DURATION_MS = 10_000;
const DEFAULT_STALE_IN_FLIGHT_MS = 5 * 60_000;

const AGENT_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// "word:iso-timestamp" -- the only source_ref shape allowed to persist as
// plain text (a closed-vocabulary word plus a validated timestamp is not
// "arbitrary source text"). Anything else is hashed instead (#53 review,
// item 6).
const WORD_TIMESTAMP_SOURCE_REF_PATTERN = /^[a-z_]+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// `owner/repo#issue:iso-timestamp` -- the recovery_attempts attempt_id shape.
const ATTEMPT_ID_SOURCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*#\d+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

function isoNow() {
  return new Date().toISOString();
}

function addMs(isoTimestamp, ms) {
  const parsed = Date.parse(isoTimestamp);
  return new Date((Number.isFinite(parsed) ? parsed : Date.now()) + ms).toISOString();
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.isInteger(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeAgentId(value) {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value) ? value : null;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * A source_ref must be a bounded identifier or a hash of one -- never
 * arbitrary source text (#53 review, item 6). Recognized closed shapes
 * (an existing sha256 hex digest, a `word:timestamp` pair, or a recovery
 * attempt id) are kept as-is so resolution-check lookups can still parse
 * them; anything else is replaced by its own sha256 hash.
 */
function boundedSourceRef(value) {
  const text = String(value ?? '');
  if (HEX64_PATTERN.test(text) || WORD_TIMESTAMP_SOURCE_REF_PATTERN.test(text) || ATTEMPT_ID_SOURCE_REF_PATTERN.test(text)) return text;
  return sha256(text);
}

/**
 * The only fields a notification's content may ever carry -- a positive
 * allowlist, validated against closed vocabularies. Returns `null` (never
 * throws) when any field fails validation, so a caller can skip a
 * malformed/corrupt row with a fixed local diagnostic instead of reaching a
 * transport with unvalidated data (#53 review, items 6 and 8).
 */
export function buildNotificationContent({ eventType, reasonCode, repo, issueNumber = null, agent = null, occurredAt }) {
  if (!NOTIFICATION_EVENT_TYPES.includes(eventType)) return null;
  if (!REASON_CODES.includes(reasonCode)) return null;
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) return null;
  if (issueNumber !== null && issueNumber !== undefined && !Number.isInteger(issueNumber)) return null;
  const sanitizedAgent = sanitizeAgentId(agent);
  if (agent != null && sanitizedAgent === null) return null;
  if (typeof occurredAt !== 'string' || !ISO_TIMESTAMP_PATTERN.test(occurredAt)) return null;
  return {
    eventType,
    reasonCode,
    repo,
    issueNumber: Number.isInteger(issueNumber) ? issueNumber : null,
    agent: sanitizedAgent,
    occurredAt,
  };
}

/** Rebuild and re-validate a due row's outbound content strictly from its own validated columns -- never from `content_json` (#53 review, item 6). */
function rebuildValidatedContent(row) {
  return buildNotificationContent({
    eventType: row.event_type, reasonCode: row.reason_code, repo: row.repo, issueNumber: row.issue_number, agent: row.agent, occurredAt: row.occurred_at,
  });
}

function candidate({ eventType, reasonCode, repo, project = null, issueNumber = null, agent = null, occurredAt, sourceTable, rawSourceRef, dedupeKeyMaterial, sourceResolved }) {
  const content = buildNotificationContent({ eventType, reasonCode, repo, issueNumber, agent, occurredAt });
  if (!content) return null;
  return {
    ...content,
    project,
    sourceTable,
    sourceRef: boundedSourceRef(rawSourceRef),
    dedupeKey: sha256(`${eventType}|${sourceTable}|${dedupeKeyMaterial}`),
    sourceResolved,
  };
}

// ---------------------------------------------------------------------------
// Source -> candidate mappings. Each accepts already repo-scoped rows (the
// cursor-batch queries in claude-runner-state.mjs filter by repo) and
// returns zero or one candidate per row. Stateful event types (everything
// except the one-shot set) are simply omitted here when `sourceResolved` is
// already true at discovery time -- never created only to be immediately
// resolved (#53 review, item 3: "do not create misleading new notifications
// for already-resolved historical attention/health conditions").
// ---------------------------------------------------------------------------

function completedCandidate(row) {
  if (row.outcome !== 'completed') return null;
  return candidate({
    eventType: 'completed', reasonCode: 'run-completed', repo: row.repo, project: row.project,
    issueNumber: row.issue_number, agent: row.agent, occurredAt: row.finished_at || row.started_at,
    sourceTable: 'recovery_attempts', rawSourceRef: row.attempt_id, dedupeKeyMaterial: row.attempt_id, sourceResolved: true,
  });
}

/**
 * A genuine task failure (#53 review, item 3) from the closed
 * `FAILURE_NOTIFY_OUTCOMES` set. Deterministic precedence against
 * double-notification: if this attempt already has an `attention_dedupe_key`
 * (an attention_events row tracks it independently), this function defers
 * entirely -- the attention_events-sourced candidate covers it. Only an
 * attempt with no attention tracking AND no further automatic-retry
 * eligibility is treated as "failed" here.
 */
function failedTaskCandidate(row) {
  if (!FAILURE_NOTIFY_OUTCOMES.includes(row.outcome)) return null;
  if (row.attention_dedupe_key) return null; // deferred to the attention_events candidate -- no double notify
  const resolved = row.resolution_state === 'resolved';
  if (resolved) return null; // already-resolved historical failure -- do not notify (#53 review, item 3)
  // The persisted source_ref is the bare `attempt_id` (#53 review round 3,
  // item 2). Round 2 stored `failed:${attempt_id}`, whose shape matched none
  // of boundedSourceRef()'s recognized patterns and was therefore replaced by
  // an opaque sha256 hash -- while the resolver still expected to parse a
  // `failed:` prefix out of it, so these rows could never resolve at all. The
  // bare attempt_id is itself a bounded, closed-shape, non-sensitive
  // identifier (repo/issue/timestamp, all already columns on this row) that
  // survives boundedSourceRef() intact and supports a targeted lookup. The
  // `failed:` discriminator stays on the dedupe key alone, which is where it
  // was actually needed: to keep this row distinct from the same attempt's
  // `completed` notification. `source_table` already distinguishes the two
  // recovery-attempt-sourced shapes from the attention_events-sourced one.
  return candidate({
    eventType: 'failed_attention', reasonCode: 'attention-required', repo: row.repo, project: row.project,
    issueNumber: row.issue_number, agent: row.agent, occurredAt: row.finished_at || row.started_at,
    sourceTable: 'recovery_attempts', rawSourceRef: row.attempt_id, dedupeKeyMaterial: `failed:${row.attempt_id}`, sourceResolved: false,
  });
}

/**
 * recovery_attempts rows are reused in place across an attempt's own retry
 * lifecycle (the same attempt_id's outcome/recovery_eligible/
 * attention_dedupe_key/resolution_state all update via UPDATE, not a fresh
 * INSERT) -- unlike attention_events, a row this pass sees as "might still
 * retry" can later update to a genuinely terminal state on the SAME row.
 * `blocked: true` tells the cursor scanner to never advance past this row
 * until it reaches a state whose fate is truly final, so a later pass
 * re-evaluates it fresh instead of silently never notifying at all.
 */
function recoveryAttemptCandidates(row) {
  if (!row.finished_at) return { items: [], blocked: true }; // still running -- not yet terminal at all
  if (row.outcome === 'completed') return { items: [completedCandidate(row)].filter(Boolean), blocked: false };
  if (FAILURE_NOTIFY_OUTCOMES.includes(row.outcome) && !row.attention_dedupe_key && row.recovery_eligible && row.resolution_state !== 'resolved') {
    return { items: [], blocked: true }; // may still self-heal via automatic retry -- not yet decided
  }
  return { items: [failedTaskCandidate(row)].filter(Boolean), blocked: false };
}

function attentionCandidates(row) {
  // attention_events' own resolved_at transition is one-way (null -> set,
  // never back) and this function's decision at discovery time is already
  // final either way, so this source never needs to block cursor advance.
  if (row.resolved_at) return { items: [], blocked: false }; // already-resolved historical attention -- do not notify (#53 review, item 3)
  const built = candidate({
    eventType: 'failed_attention', reasonCode: 'attention-required', repo: row.repo, project: row.project,
    issueNumber: row.issue_number, agent: row.agent, occurredAt: row.started_at || row.created_at,
    sourceTable: 'attention_events', rawSourceRef: row.dedupe_key, dedupeKeyMaterial: row.dedupe_key, sourceResolved: false,
  });
  return { items: built ? [built] : [], blocked: false };
}

/**
 * Only a routing event whose GitHub mutation is proven applied may announce
 * a reassignment or no-qualified-agent outcome (#53 review round 3, item 6).
 * Proof is an exact allowlist match against `ROUTING_PROVEN_DELIVERY_
 * STATUSES` -- every other value, including `mutation-pending`, NULL, and
 * any corrupt/legacy/future status, fails closed: no notification is ever
 * created from it.
 *
 * Such a row is marked `blocked` rather than skipped, because #50 updates
 * these rows in place as the mutation is verified -- a reassignment proven
 * applied one pass later must still be notified. Since round 3 (item 4), a
 * blocked row only holds its own cursor position; it no longer stops later
 * independent rows in the same batch from persisting their intents, so a
 * permanently-corrupt status cannot stall the whole source.
 */
function routingCandidates(row, { onUnknownStatus } = {}) {
  if (!ROUTING_PROVEN_DELIVERY_STATUSES.has(row.delivery_status)) {
    if (!ROUTING_KNOWN_DELIVERY_STATUSES.has(row.delivery_status)) onUnknownStatus?.();
    return { items: [], blocked: true };
  }
  if (row.event_type !== 'reassignment' && row.event_type !== 'no-qualified-agent') return { items: [], blocked: false };
  const isReassignment = row.event_type === 'reassignment';
  const built = candidate({
    eventType: isReassignment ? 'agent_reassigned' : 'no_qualified_agent',
    reasonCode: isReassignment ? 'agent-disabled-reassigned' : 'no-qualified-agent',
    repo: row.repo, issueNumber: row.issue_number, agent: isReassignment ? row.to_agent_id : null,
    occurredAt: row.created_at, sourceTable: 'routing_events', rawSourceRef: row.dedupe_key, dedupeKeyMaterial: row.dedupe_key, sourceResolved: true,
  });
  return { items: built ? [built] : [], blocked: false };
}

/**
 * Scanned directly every pass, not via cursor -- see the CURSOR_SOURCES
 * comment for why. Returns a plain array (no `blocked` semantics needed
 * outside the cursor mechanism).
 */
function healthConditionCandidates(row) {
  const reasonCode = HEALTH_CONDITION_REASON_CODES[row.condition_type];
  if (!reasonCode) return []; // unrecognized condition type -- closed mapping, never a generic fallback
  if (row.resolved_at) return []; // already-resolved historical episode -- do not notify (#53 review, item 3)
  const rawSourceRef = `${row.condition_type}:${row.opened_at}`;
  const built = candidate({
    eventType: 'systemic_pause', reasonCode, repo: row.repo, occurredAt: row.opened_at,
    sourceTable: 'runner_health_conditions', rawSourceRef, dedupeKeyMaterial: rawSourceRef, sourceResolved: false,
  });
  return built ? [built] : [];
}

/**
 * Repository-scoped and occurrence-specific (#53 review, item 3): reads
 * only the latest quota_history row for THIS repo (never a globally-latest
 * row later filtered by repo), and never defaults a missing reset timestamp
 * to a shared "unspecified" bucket that would suppress every later blocked
 * episode. Instead, creation is gated on "no currently-open quota_blocked
 * notification exists for this repo" -- itself the occurrence boundary --
 * and each newly-detected episode's occurrence anchor is the current
 * reconciliation timestamp, unique to that detection. No cursor is used
 * (or needed): this only ever inspects the single latest row, so it can
 * never flood historical backfill.
 */
function quotaBlockedCandidate({ state, repo, now }) {
  const latest = state.invoke('latestQuotaHistoryForRepo', repo);
  if (!latest || !latest.blocked) return null;
  const alreadyOpen = state.invoke('openNotificationExists', repo, 'quota_blocked');
  if (alreadyOpen) return null;
  const occurrenceAnchor = now();
  return candidate({
    eventType: 'quota_blocked', reasonCode: 'quota-or-paid-use-blocked', repo, occurredAt: latest.created_at || occurrenceAnchor,
    sourceTable: 'quota_history', rawSourceRef: `quota-episode:${occurrenceAnchor}`, dedupeKeyMaterial: `quota-episode:${occurrenceAnchor}`, sourceResolved: false,
  });
}

// ---------------------------------------------------------------------------
// Durable, activation-gated, bounded-batch source scanning (#53 review, item
// 4). On first activation for a (repo, source_table) pair, the cursor is set
// to the current tail of that table -- deliberately skipping ALL pre-
// existing history in one step, so deploying this outbox never floods
// notifications for years of already-settled data. Every later pass reads
// only rows strictly past the cursor, in a bounded batch, and the cursor is
// advanced only up to the last row this pass durably finished processing --
// never blindly to the end of the fetched batch -- so a mid-batch failure
// resumes correctly rather than silently skipping the remainder.
// ---------------------------------------------------------------------------

// runner_health_conditions is deliberately NOT a cursor source: it is
// upserted in place per (repo, condition_type) -- reopening an episode
// updates the SAME row (same id) rather than inserting a new one, so an
// id-based "rows past the cursor" scan would never see a reopened episode
// again after its first scan. It is instead scanned directly every pass
// (like quota below); this is safe and bounded because the table carries at
// most one row per known condition type, and the sourceResolved-at-
// discovery gate in healthConditionCandidates() already prevents ever
// backfilling an already-resolved historical episode, while dedupe_key
// (which embeds the exact opened_at) already prevents re-notifying the
// same still-open episode on a repeated pass.
const CURSOR_SOURCES = Object.freeze([
  {
    table: 'attention_events',
    fetchSince: (state, repo, cursor, limit) => state.invoke('attentionEventsSince', repo, cursor, limit) || [],
    fetchByRowKeys: (state, repo, rowKeys) => state.invoke('attentionEventsByIds', repo, rowKeys),
    tailValue: (state, repo) => state.invoke('maxRowId', 'attention_events', repo),
    rowCursorValue: (row) => row.id,
    buildCandidates: attentionCandidates,
  },
  {
    table: 'routing_events',
    fetchSince: (state, repo, cursor, limit) => state.invoke('routingEventsSince', repo, cursor, limit) || [],
    fetchByRowKeys: (state, repo, rowKeys) => state.invoke('routingEventsByIds', repo, rowKeys),
    tailValue: (state, repo) => state.invoke('maxRowId', 'routing_events', repo),
    rowCursorValue: (row) => row.id,
    buildCandidates: (row, context) => routingCandidates(row, context),
  },
  {
    // Cursored on SQLite `rowid`, not `started_at` (#53 review round 3, item
    // 3): a timestamp cursor silently dropped any genuinely-new attempt that
    // shared the boundary millisecond. `rowid` is unique and strictly
    // increasing per insert, and is unaffected by the in-place UPDATEs
    // `recordRecoveryAttempt()` performs on an existing attempt_id.
    table: 'recovery_attempts',
    fetchSince: (state, repo, cursor, limit) => state.invoke('recoveryAttemptsSince', repo, cursor, limit) || [],
    fetchByRowKeys: (state, repo, rowKeys) => state.invoke('recoveryAttemptsByRowIds', repo, rowKeys),
    tailValue: (state, repo) => state.invoke('maxRecoveryAttemptRowId', repo),
    rowCursorValue: (row) => row.row_id,
    buildCandidates: recoveryAttemptCandidates,
  },
]);

/** Every cursor source is now keyed on a monotonic integer (id or rowid); a stored cursor of any other shape predates that and must be re-activated rather than trusted (#53 review round 3, item 3). */
function isUsableCursor(value) {
  return /^\d+$/.test(String(value));
}

function persistCandidate(state, item, maxAttempts) {
  return state.invoke('recordNotificationEvent', {
    repo: item.repo, project: item.project, issueNumber: item.issueNumber, eventType: item.eventType, reasonCode: item.reasonCode,
    agent: item.agent, sourceTable: item.sourceTable, sourceRef: item.sourceRef, occurredAt: item.occurredAt, dedupeKey: item.dedupeKey,
    content: { eventType: item.eventType, reasonCode: item.reasonCode, repo: item.repo, issueNumber: item.issueNumber, agent: item.agent, occurredAt: item.occurredAt },
    maxAttempts,
  });
}

/**
 * Evaluate one already-fetched source row. Never throws: a per-row
 * candidate-build exception is caught, recorded as a fixed local
 * diagnostic, and treated as "no candidate for this row" so one malformed
 * source row can never abort the whole batch or escalate to a systemic
 * failure (#53 review, item 8).
 */
function evaluateSourceRow(state, source, row) {
  try {
    const built = source.buildCandidates(row, {
      onUnknownStatus: () => state.recordTaskError('notification-source-status-unknown', new Error('source-row-invalid')),
    });
    return Array.isArray(built) ? { items: built, blocked: false } : (built || { items: [], blocked: false });
  } catch (error) {
    state.recordTaskError('notification-source-row-invalid', new Error('source-row-invalid'));
    return { items: [], blocked: false };
  }
}

/** Persist every candidate a decided row produced. Returns `false` on a systemic write failure (never a per-row skip), so the caller can stop without advancing any frontier past it. */
function persistRowCandidates(state, items, maxAttempts, onInserted) {
  for (const item of items) {
    const recorded = persistCandidate(state, item, maxAttempts);
    if (recorded == null) return false; // state.invoke returned null: a systemic write failure
    if (recorded.inserted) onInserted();
  }
  return true;
}

/**
 * Frontier 2 (#53 review round 4, item 2): recheck a bounded, rotating batch
 * of durably-deferred row identities for one source.
 *
 * Round 3 kept undecided rows revisitable by parking the single durable
 * cursor immediately before the first one. That only worked inside the batch
 * window that pass happened to fetch: if the blocked row was first and more
 * than `batchSize - 1` later rows existed, every pass refetched the identical
 * window and nothing beyond it was ever reached. The cursor is now a pure
 * monotonic high-water mark that advances through blocked rows too, and the
 * undecided identities live here instead -- so an arbitrarily long backlog
 * keeps flowing while a blocked row is still rechecked on every pass and
 * still produces exactly one intent when it finally becomes final.
 *
 * A deferred row whose source row no longer exists is dropped (nothing left
 * to decide). A row that is still blocked is touched, moving it to the back
 * of the rotation so no single permanently-undecided row can monopolise the
 * recheck budget.
 */
function recheckDeferredSourceRows({ state, repo, source, batchSize, maxAttempts, at }) {
  const deferred = state.invoke('deferredNotificationSourceRows', repo, source.table, batchSize) || [];
  if (deferred.length === 0) return { inserted: 0, cleared: 0, stillDeferred: 0 };
  const rows = source.fetchByRowKeys(state, repo, deferred.map((entry) => entry.row_key)) || [];
  const byRowKey = new Map(rows.map((row) => [Number(source.rowCursorValue(row)), row]));
  let inserted = 0;
  let cleared = 0;
  let stillDeferred = 0;
  for (const entry of deferred) {
    if (!state.healthy) break;
    const row = byRowKey.get(Number(entry.row_key));
    if (!row) {
      // The source row is gone entirely -- there is no fate left to wait for.
      state.invoke('clearDeferredNotificationSourceRow', { repo, sourceTable: source.table, rowKey: entry.row_key });
      cleared += 1;
      continue;
    }
    const result = evaluateSourceRow(state, source, row);
    if (result.blocked) {
      state.invoke('touchDeferredNotificationSourceRow', { repo, sourceTable: source.table, rowKey: entry.row_key, at });
      stillDeferred += 1;
      continue;
    }
    if (!persistRowCandidates(state, result.items, maxAttempts, () => { inserted += 1; })) break;
    // Only drop the deferred identity once its intent is durably persisted,
    // so a crash between the two simply rechecks the row next pass and
    // `dedupe_key` makes the re-persist an exact no-op -- exactly one intent.
    state.invoke('clearDeferredNotificationSourceRow', { repo, sourceTable: source.table, rowKey: entry.row_key });
    cleared += 1;
  }
  return { inserted, cleared, stillDeferred };
}

/**
 * Frontier 1 (#53 review round 4, item 2): activate-then-scan exactly one
 * cursor source from its monotonic high-water mark. Returns the count of
 * genuinely new notification rows inserted.
 *
 * The cursor now advances across every row this pass actually evaluated,
 * including undecided ones -- those are handed to the durable deferred set
 * instead (`recheckDeferredSourceRows()` above). It is still never advanced
 * past a row whose durable write failed, so a mid-batch store failure resumes
 * correctly rather than silently skipping the remainder.
 */
function scanCursorSource({ state, repo, source, batchSize, maxAttempts, at }) {
  const cursor = state.invoke('getNotificationSourceCursor', repo, source.table);
  if (cursor === null) {
    const tail = source.tailValue(state, repo);
    state.invoke('activateNotificationSourceCursor', repo, source.table, tail ?? 0);
    return { inserted: 0, deferred: 0, activated: true };
  }
  if (!isUsableCursor(cursor)) {
    // A stored cursor in a shape this source no longer understands (the
    // pre-round-3 `started_at` recovery cursor). Re-activate past the current
    // tail rather than re-scanning history: activation semantics are exactly
    // "skip everything that already exists", which is the safe reading of an
    // uninterpretable cursor (#53 review round 3, item 3).
    state.invoke('advanceNotificationSourceCursor', repo, source.table, source.tailValue(state, repo) ?? 0);
    return { inserted: 0, deferred: 0, activated: true };
  }
  const rows = source.fetchSince(state, repo, cursor, batchSize);
  let inserted = 0;
  let deferred = 0;
  let highWater = cursor;
  for (const row of rows) {
    const rowKey = source.rowCursorValue(row);
    const result = evaluateSourceRow(state, source, row);
    if (result.blocked) {
      const recorded = state.invoke('deferNotificationSourceRow', { repo, sourceTable: source.table, rowKey, at });
      // A failed defer must NOT let the high-water mark move past this row:
      // the row would then be unreachable from both frontiers.
      if (recorded == null) break;
      if (recorded.deferred) deferred += 1;
      highWater = rowKey;
      continue;
    }
    if (!persistRowCandidates(state, result.items, maxAttempts, () => { inserted += 1; })) break;
    if (!state.healthy) break;
    highWater = rowKey;
  }
  if (String(highWater) !== String(cursor)) state.invoke('advanceNotificationSourceCursor', repo, source.table, highWater);
  return { inserted, deferred, activated: false };
}

/**
 * Disabled by default (#53: "keep all delivery transports disabled by
 * default" / "do not send a real email, webhook, Slack message, SMS, push
 * notification or provider request under this packet"). Makes no network
 * call, no filesystem write, no process spawn. Returns `paused: true` --
 * distinct from a genuine delivery failure -- so the reconciler preserves
 * the row exactly as-is (no attempt consumed, no error recorded) until a
 * real transport is later enabled under a separately authorized packet
 * (#53 review, item 1).
 */
export function createDisabledNotificationTransport() {
  return async function disabledNotificationTransport() {
    return { ok: false, paused: true, reasonCode: 'transport-disabled' };
  };
}

/**
 * Test-only synthetic capture transport (#53: "use dependency-injected
 * synthetic notification delivery during tests. Do not send a real email,
 * webhook, Slack message, SMS, push notification or provider request").
 * Captures each delivered notification's bounded content (plus the
 * idempotency key it was handed) in-memory; never performs any real I/O.
 */
export function createSyntheticNotificationTransport({ fail = () => false, retryable = true } = {}) {
  const deliveries = [];
  const attempts = [];
  const transport = async (notification) => {
    attempts.push(notification);
    if (fail(notification, attempts.length)) {
      return retryable
        ? { ok: false, retryable: true, reasonCode: 'transport-rejected-retryable' }
        : { ok: false, retryable: false, reasonCode: 'transport-rejected-permanent' };
    }
    deliveries.push(notification);
    return { ok: true };
  };
  return { transport, deliveries, attempts };
}

/** Race a transport call against a bounded timeout so a hung/never-resolving transport can never hold delivery open indefinitely (#53 review, item 5). */
async function deliverWithTimeout(transport, content, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, retryable: true, reasonCode: 'transport-timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => transport(content)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A transport's returned reasonCode must itself be one of the closed DELIVERY_REASON_CODES before it is ever persisted or logged (#53 review, item 6). */
function boundedDeliveryReasonCode(reasonCode) {
  return DELIVERY_REASON_CODES.includes(reasonCode) ? reasonCode : 'transport-rejected-retryable';
}

/**
 * Whether a stateful notification's underlying source condition has already
 * cleared. Every branch uses a targeted, indexed, single-row lookup keyed on
 * the notification's own persisted `source_ref` -- never an
 * `allRows(<table>)` full scan repeated per notification (#53 review round
 * 3, item 7).
 *
 * This function reports only what it could actually read. Because
 * `state.invoke()` converts a store exception into `null` while flipping
 * `state.healthy` false, a `null` here is indistinguishable from real source
 * truth -- so every caller MUST re-check `state.healthy` immediately after
 * calling this and, if it is false, perform no delivery and no resolution
 * (#53 review round 4, item 1). This function deliberately does not try to
 * guess: guessing is exactly the failure mode being corrected.
 *
 * Unparseable/unrecognized `source_ref` shapes fail CLOSED (return `false`,
 * "not proven cleared"). A reference this module cannot interpret is not
 * evidence a condition ended, and an attention or systemic-pause alert that
 * stays visible is strictly safer than one silently retired. The only
 * event type where a permanently-unresolved row would suppress future
 * notifications is `quota_blocked`, and its branch does not parse
 * `source_ref` at all -- it re-reads live quota truth for the repo.
 */
function isSourceResolvedNow({ row, state }) {
  if (ONE_SHOT_EVENT_TYPES.has(row.event_type)) return true;
  if (row.event_type === 'failed_attention') {
    if (row.source_table === 'attention_events') {
      // source_ref is the attention row's own sha256 dedupe_key, kept intact
      // by boundedSourceRef() -- a direct unique-key lookup.
      const match = state.invoke('attentionEventByDedupeKey', row.repo, row.source_ref);
      return Boolean(match?.resolved_at);
    }
    // source_table === 'recovery_attempts': the failed_attention-derived-
    // directly-from-an-attempt path. source_ref is the bare attempt_id
    // (#53 review round 3, item 2), so this is a direct primary-key lookup.
    if (!ATTEMPT_ID_SOURCE_REF_PATTERN.test(row.source_ref)) return false;
    const match = state.invoke('recoveryAttemptByAttemptId', row.repo, row.source_ref);
    return Boolean(match && match.resolution_state === 'resolved');
  }
  if (row.event_type === 'systemic_pause') {
    // Exact-episode matching (#53 review, item 3): a later episode of the
    // SAME condition_type must never keep an OLDER episode unresolved
    // forever, and must never falsely resolve it either -- only a match on
    // this row's own captured opened_at counts as resolution, except when
    // the live row has moved on to a strictly newer opened_at, which can
    // only mean this row's own episode has already ended.
    const parsed = /^([a-z_]+):(.+)$/.exec(row.source_ref);
    if (!parsed) return false; // uninterpretable reference -- fail closed, keep the alert visible
    const [, conditionType, openedAt] = parsed;
    const live = state.invoke('healthConditionForType', row.repo, conditionType);
    if (!live) return true; // the condition row itself is gone -- nothing left open
    if (live.opened_at === openedAt) return Boolean(live.resolved_at);
    return live.opened_at > openedAt; // a strictly newer episode has started -- ours has ended
  }
  if (row.event_type === 'quota_blocked') {
    const latest = state.invoke('latestQuotaHistoryForRepo', row.repo);
    if (!latest) return true; // no current data for this repo -- nothing left to be blocked by
    return !latest.blocked;
  }
  return true;
}

/**
 * The full reconciliation pass (#53, hardened per manager review round 2):
 *
 * 1. Reconcile a bounded batch of stale in-flight rows (a prior process
 *    crashed mid-delivery).
 * 2. Activation-gated, bounded-batch, TWO-FRONTIER discovery+persistence for
 *    attention/routing/recovery-attempt sources: a durable rotating recheck
 *    of previously-undecided row identities, then a forward scan from a
 *    monotonic high-water cursor (#53 review round 4, item 2).
 * 3. Direct (non-cursor) discovery+persistence for runner_health_conditions
 *    -- upserted in place per condition type, so it cannot use the cursor
 *    mechanism; bounded because at most one row exists per known type.
 * 4. Repository-scoped, occurrence-specific quota discovery+persistence.
 * 5. Claim-then-revalidate-then-deliver a bounded batch of due rows, each
 *    against a bounded delivery timeout, within a bounded total pass
 *    duration -- so a hung, rejected or throwing transport can never hold
 *    the caller's serial execution lock open or starve the next eligible
 *    engineering issue (#53 review, item 5). A stateful row whose source
 *    condition has cleared since discovery is resolved in place instead of
 *    delivered (#53 review round 3, item 1).
 * 6. Recheck a bounded, durably-rotating batch of unresolved stateful rows
 *    -- pending, retryable-failed, delivered or exhausted -- for source
 *    resolution, so no long-lived group can starve another (round 4, item 3).
 *
 * Any source-truth lookup that makes the state unhealthy stops the pass
 * immediately, with no transport call and no resolution (round 4, item 1).
 *
 * Never throws: every per-row/per-stage failure is caught and recorded via
 * `state.recordTaskError()` using only a fixed reason code (never a raw
 * exception message), so a notification-local fault can never propagate
 * into the caller's queue/claim/run/routing/recovery state or its serial
 * lock lifecycle.
 */
export async function reconcileNotifications({
  state, args, transport = createDisabledNotificationTransport(), now = isoNow,
  retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS, batchSize = DEFAULT_BATCH_SIZE,
  deliveryTimeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS, maxPassDurationMs = DEFAULT_MAX_PASS_DURATION_MS,
  staleInFlightMs = DEFAULT_STALE_IN_FLIGHT_MS,
}) {
  const summary = { discovered: 0, inserted: 0, delivered: 0, paused: 0, retried: 0, exhausted: 0, resolved: 0, staleRecovered: 0, deferred: 0 };
  if (!state.healthy) return summary;
  const repo = args.repo;
  const boundedMaxAttempts = clampInt(maxAttempts, 1, 20, DEFAULT_MAX_ATTEMPTS);
  const boundedBatchSize = clampInt(batchSize, 1, 200, DEFAULT_BATCH_SIZE);
  const boundedDeliveryTimeoutMs = clampInt(deliveryTimeoutMs, 100, 30_000, DEFAULT_DELIVERY_TIMEOUT_MS);
  const boundedMaxPassDurationMs = clampInt(maxPassDurationMs, 500, 60_000, DEFAULT_MAX_PASS_DURATION_MS);
  const boundedStaleInFlightMs = clampInt(staleInFlightMs, 1_000, 3_600_000, DEFAULT_STALE_IN_FLIGHT_MS);
  const passStartedAt = Date.now();
  const passDeadlineExceeded = () => Date.now() - passStartedAt >= boundedMaxPassDurationMs;

  // Step 1: crash-safe in-flight reconciliation, onto the SAME notification identity.
  try {
    // Bounded in SQL (#53 review round 4, additional boundedness): a large
    // crash backlog is drained across repeated passes, oldest claim first,
    // never loaded and updated in one unbounded sweep while the caller holds
    // the serial scheduler lock.
    const staleResult = state.invoke('reconcileStaleInFlightNotifications', {
      repo, staleBeforeAt: addMs(now(), -boundedStaleInFlightMs), at: now(), errorCode: 'stale-in-flight-recovered', limit: boundedBatchSize,
    });
    summary.staleRecovered = staleResult?.recovered || 0;
  } catch (error) {
    state.recordTaskError('notification-stale-reconcile-failed', new Error('stale-in-flight-recovered'));
  }
  if (!state.healthy) return summary;

  // Step 2: two-frontier, activation-gated, bounded discovery for the cursor
  // sources (#53 review round 4, item 2). The deferred frontier is rechecked
  // first (older, already-known work before newly-scanned work), then the
  // monotonic high-water cursor scans forward -- so a permanently blocked row
  // never prevents rows an arbitrary number of batch windows later from
  // becoming outbox intents.
  for (const source of CURSOR_SOURCES) {
    if (!state.healthy) return summary;
    try {
      const revisited = recheckDeferredSourceRows({ state, repo, source, batchSize: boundedBatchSize, maxAttempts: boundedMaxAttempts, at: now() });
      summary.inserted += revisited.inserted;
      summary.discovered += revisited.inserted;
      const result = scanCursorSource({ state, repo, source, batchSize: boundedBatchSize, maxAttempts: boundedMaxAttempts, at: now() });
      summary.inserted += result.inserted;
      summary.discovered += result.inserted;
      summary.deferred += result.deferred;
    } catch (error) {
      state.recordTaskError('notification-source-scan-failed', new Error('source-row-invalid'));
    }
  }

  // Step 3: runner_health_conditions -- scanned directly every pass, not
  // via cursor (see the CURSOR_SOURCES comment above for why). Bounded in
  // SQL to the closed set of condition types this module can notify about,
  // still open, with a LIMIT -- never "load every historical/unknown health
  // row and filter in JavaScript" (#53 review round 3, item 7).
  if (state.healthy) {
    try {
      const healthRows = state.invoke('openHealthConditionsForTypes', repo, Object.keys(HEALTH_CONDITION_REASON_CODES), boundedBatchSize) || [];
      for (const row of healthRows) {
        for (const item of healthConditionCandidates(row)) {
          const recorded = persistCandidate(state, item, boundedMaxAttempts);
          if (recorded?.inserted) { summary.inserted += 1; summary.discovered += 1; }
        }
        if (!state.healthy) break;
      }
    } catch (error) {
      state.recordTaskError('notification-health-discovery-failed', new Error('source-row-invalid'));
    }
  }

  // Step 4: repository-scoped, occurrence-specific quota discovery (no cursor -- see quotaBlockedCandidate()).
  if (state.healthy) {
    try {
      const quotaCandidate = quotaBlockedCandidate({ state, repo, now });
      if (quotaCandidate) {
        const recorded = persistCandidate(state, quotaCandidate, boundedMaxAttempts);
        if (recorded?.inserted) { summary.inserted += 1; summary.discovered += 1; }
      }
    } catch (error) {
      state.recordTaskError('notification-quota-discovery-failed', new Error('source-row-invalid'));
    }
  }

  if (!state.healthy) return summary;

  // Step 5: claim-then-deliver a bounded batch, each within a bounded
  // timeout, within a bounded total pass duration.
  // Bounded by SQL LIMIT, not by loading every due row and slicing here
  // (#53 review round 3, item 7).
  const due = state.invoke('dueNotificationEvents', repo, now(), boundedBatchSize) || [];
  for (const row of due) {
    if (passDeadlineExceeded()) break;
    if (!state.healthy) return summary;
    const owner = `pass:${now()}`;
    const claim = state.invoke('claimNotificationForDelivery', { dedupeKey: row.dedupe_key, owner, at: now() });
    if (!claim?.claimed) continue; // already claimed/moved by another pass -- never double-claim

    // Revalidate stateful source truth immediately before the transport call
    // (#53 review round 3, item 1). A condition can clear between discovery
    // and delivery -- or across the many passes a paused/retrying row waits
    // through -- and delivering then would announce a stale alert for
    // something already fixed. Resolve it in place instead, without
    // delivering and without consuming an attempt. One-shot event types
    // never take this path: they describe a moment that already happened and
    // have no source condition that can clear.
    if (STATEFUL_EVENT_TYPES.has(row.event_type)) {
      let clearedNow = false;
      try {
        clearedNow = isSourceResolvedNow({ row, state });
      } catch (error) {
        state.recordTaskError('notification-resolution-check-failed', new Error('source-row-invalid'));
      }
      // FAIL CLOSED (#53 review round 4, item 1). `state.invoke()` turns a
      // store exception into `null` AND flips `state.healthy` false, and
      // `isSourceResolvedNow()` cannot distinguish that `null` from genuine
      // source truth: for attention/recovery it reads as "still unresolved"
      // (delivery would continue), and for health/quota as "source cleared"
      // (the row would be resolved). Neither is knowledge. A source-truth
      // read failure must therefore produce NO transport call and NO
      // resolution -- the pass stops here, the store failure stays systemic
      // rather than being downgraded to a task-local success, and this row
      // simply remains 'in-flight' for the ordinary stale-claim recovery path
      // to requeue (without consuming an attempt).
      if (!state.healthy) return summary;
      if (clearedNow) {
        const resolved = state.invoke('resolveStatefulNotificationEvent', { dedupeKey: row.dedupe_key, resolvedAt: now() });
        if (resolved) summary.resolved += 1;
        else state.recordTaskError('notification-state-transition-mismatch', new Error('state-transition-mismatch'));
        continue;
      }
    }

    const content = rebuildValidatedContent(row);
    if (!content) {
      // A corrupt/malformed durable row: never reach a transport with unvalidated data (#53 review, items 6/8).
      state.invoke('markNotificationDeliveryFailed', { dedupeKey: row.dedupe_key, attemptedAt: now(), errorCode: 'transport-rejected-permanent', retryable: false });
      state.recordTaskError('notification-row-invalid', new Error('transport-rejected-permanent'));
      continue;
    }

    let outcome;
    try {
      outcome = await deliverWithTimeout(transport, { ...content, idempotencyKey: row.dedupe_key }, boundedDeliveryTimeoutMs);
    } catch (error) {
      outcome = { ok: false, retryable: true, reasonCode: 'transport-threw' };
      state.recordTaskError('notification-delivery-threw', new Error('transport-threw'));
    }

    if (outcome?.paused) {
      const reverted = state.invoke('revertNotificationInFlightToPending', { dedupeKey: row.dedupe_key, at: now() });
      if (reverted) summary.paused += 1;
      else state.recordTaskError('notification-state-transition-mismatch', new Error('state-transition-mismatch'));
      continue;
    }

    if (outcome?.ok) {
      const resolveNow = ONE_SHOT_EVENT_TYPES.has(row.event_type);
      const delivered = state.invoke('markNotificationDelivered', { dedupeKey: row.dedupe_key, deliveredAt: now(), resolveNow });
      if (delivered) { // #53 review, item 7: only count success once the durable write is proven
        summary.delivered += 1;
        if (resolveNow) summary.resolved += 1;
      } else {
        state.recordTaskError('notification-state-transition-mismatch', new Error('state-transition-mismatch'));
      }
      continue;
    }

    const retryable = outcome?.retryable !== false;
    const boundedReason = boundedDeliveryReasonCode(outcome?.reasonCode);
    const result = state.invoke('markNotificationDeliveryFailed', {
      dedupeKey: row.dedupe_key, attemptedAt: now(), errorCode: boundedReason, retryable,
      nextAttemptAt: retryable ? addMs(now(), retryBackoffMs) : null,
    });
    if (!result?.updated) {
      state.recordTaskError('notification-state-transition-mismatch', new Error('state-transition-mismatch'));
    } else if (result.exhausted) {
      summary.exhausted += 1;
    } else {
      summary.retried += 1;
    }
  }

  if (!state.healthy || passDeadlineExceeded()) return summary;

  // Step 6: recheck EVERY unresolved stateful row for source resolution --
  // whatever delivery stage it reached (#53 review round 3, item 1). Round 2
  // rechecked only `delivered` rows, so a still-pending, retrying or
  // exhausted row whose source had already cleared stayed unresolved: it
  // could later be delivered as a stale alert, and an exhausted quota row
  // kept `openNotificationExists()` suppressing every subsequent
  // quota_blocked episode for that repo forever. Bounded by SQL LIMIT and
  // filtered to the stateful event types in SQL (item 7).
  //
  // The sweep is FAIR (#53 review round 4, item 3): it walks a durable
  // rotating cursor over `notification_events.id` and wraps back to the start
  // once it reaches the tail, instead of always rescanning the oldest rows by
  // `created_at`. Round 3's fixed oldest-first window meant a
  // permanently-open set of older attention/systemic rows larger than one
  // batch occupied every sweep forever: a newer cleared or exhausted quota
  // row was never rechecked, stayed unresolved, and kept
  // `openNotificationExists()` suppressing every later quota episode for the
  // repo. With rotation, every unresolved row of every event type -- quota,
  // attention and systemic alike -- is rechecked within a bounded number of
  // passes, the progress survives restart/reopen, one-shot types stay
  // excluded in SQL, and no query is unbounded.
  const resolutionCursor = state.invoke('getNotificationResolutionCursor', repo) ?? 0;
  const unresolved = state.invoke('unresolvedStatefulNotificationEvents', repo, resolutionCursor, boundedBatchSize) || [];
  let sweptToId = resolutionCursor;
  let sweptWholeWindow = true;
  for (const row of unresolved) {
    if (passDeadlineExceeded()) { sweptWholeWindow = false; break; }
    let resolvedNow = false;
    try {
      resolvedNow = isSourceResolvedNow({ row, state });
    } catch (error) {
      state.recordTaskError('notification-resolution-check-failed', new Error('source-row-invalid'));
      sweptToId = Number(row.id);
      continue;
    }
    // Same fail-closed rule as the pre-delivery revalidation above (#53
    // review round 4, item 1): a store read failure is not evidence a source
    // cleared, so nothing is resolved and the cursor is not advanced past a
    // row whose truth was never actually established.
    if (!state.healthy) return summary;
    if (resolvedNow) {
      const resolved = state.invoke('resolveStatefulNotificationEvent', { dedupeKey: row.dedupe_key, resolvedAt: now() });
      if (resolved) summary.resolved += 1;
      else state.recordTaskError('notification-state-transition-mismatch', new Error('state-transition-mismatch'));
    }
    sweptToId = Number(row.id);
  }
  // Wrap back to the start once this sweep reached the tail (a short batch
  // means there is nothing past it right now), so long-lived unresolved rows
  // are revisited on a bounded rotation instead of only once.
  const reachedTail = sweptWholeWindow && unresolved.length < boundedBatchSize;
  state.invoke('setNotificationResolutionCursor', repo, reachedTail ? 0 : sweptToId, now());

  return summary;
}
