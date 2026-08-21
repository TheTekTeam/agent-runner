import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  projectFromRegistryById,
  projectFromRegistryByRepository,
} from './agent-runner-project-registry.mjs';

export const MANAGEMENT_EVENT_SCHEMA_VERSION = 1;
export const MANAGEMENT_EVENT_TYPES = Object.freeze([
  'programme-reconcile-required',
  'execution-reconcile-required',
  'queue-assurance-required',
  'delayed-event-ready',
]);
export const MANAGEMENT_EVENT_STATES = Object.freeze([
  'pending',
  'claimed',
  'settled',
  'blocked',
  'dead-letter',
]);

const MANAGEMENT_EVENT_TYPE_SET = new Set(MANAGEMENT_EVENT_TYPES);
const RECONCILIATION_EVENT_TYPES = new Set([
  'programme-reconcile-required',
  'execution-reconcile-required',
  'queue-assurance-required',
]);
const ACTIVE_EVENT_STATES = Object.freeze(['pending', 'claimed']);
const INPUT_KEYS = new Set([
  'eventType',
  'projectId',
  'repository',
  'issueNumber',
  'pullRequestNumber',
  'sha',
  'correlationId',
  'predecessorEventId',
  'notBefore',
  'deadlineAt',
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const OUTCOME_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const MAX_DUE_SCAN = 200;
const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function iso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date.toISOString();
}

function optionalPositiveInteger(value, name) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a positive bounded integer`);
  }
  return value;
}

function boundedInteger(value, fallback, { name, min, max }) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function optionalId(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredId(value, name) {
  const normalized = optionalId(value, name);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalSha(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw new Error('management event sha is invalid');
  return value.toLowerCase();
}

function assertOnlyAllowlistedInputKeys(input) {
  if (!isObject(input)) throw new Error('management event must be an object');
  const unknown = Object.keys(input).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`management event contains unsupported field(s): ${unknown.sort().join(', ')}`);
  }
}

function projectIdentity(registry, projectId, repository) {
  if (!registry || !isObject(registry)) throw new Error('management event project registry is required');
  const byId = projectFromRegistryById(registry, projectId);
  const byRepo = projectFromRegistryByRepository(registry, repository);
  if (!byId || !byRepo || byId.projectId !== byRepo.projectId) {
    throw new Error('management event project/repository identity is not enabled by the registry');
  }
  if (byId.projectId !== projectId || byId.githubRepo.toLowerCase() !== String(repository).toLowerCase()) {
    throw new Error('management event project/repository identity mismatch');
  }
  return { projectId: byId.projectId, repository: byId.githubRepo };
}

function eventCoalesceMaterial(event) {
  const scope = {
    eventType: event.eventType,
    projectId: event.projectId,
    repository: event.repository.toLowerCase(),
    issueNumber: event.issueNumber,
    pullRequestNumber: event.pullRequestNumber,
  };
  if (!RECONCILIATION_EVENT_TYPES.has(event.eventType)) scope.correlationId = event.correlationId;
  return scope;
}

export function normalizeManagementEvent(input, {
  registry,
  now = new Date().toISOString(),
} = {}) {
  assertOnlyAllowlistedInputKeys(input);
  if (!MANAGEMENT_EVENT_TYPE_SET.has(input.eventType)) {
    throw new Error(`management event type is not allowlisted: ${String(input.eventType ?? '')}`);
  }
  const projectId = requiredId(input.projectId, 'management event projectId');
  if (typeof input.repository !== 'string' || input.repository.length === 0 || input.repository.length > 255) {
    throw new Error('management event repository is required');
  }
  const identity = projectIdentity(registry, projectId, input.repository);
  const createdAt = iso(now, 'management event timestamp');
  const notBefore = input.notBefore == null ? createdAt : iso(input.notBefore, 'management event notBefore');
  const deadlineAt = input.deadlineAt == null ? null : iso(input.deadlineAt, 'management event deadlineAt');
  if (deadlineAt && Date.parse(deadlineAt) < Date.parse(notBefore)) {
    throw new Error('management event deadlineAt cannot be before notBefore');
  }

  const event = {
    schemaVersion: MANAGEMENT_EVENT_SCHEMA_VERSION,
    eventType: input.eventType,
    projectId: identity.projectId,
    repository: identity.repository,
    issueNumber: optionalPositiveInteger(input.issueNumber, 'management event issueNumber'),
    pullRequestNumber: optionalPositiveInteger(input.pullRequestNumber, 'management event pullRequestNumber'),
    sha: optionalSha(input.sha),
    correlationId: requiredId(input.correlationId, 'management event correlationId'),
    predecessorEventId: optionalId(input.predecessorEventId, 'management event predecessorEventId'),
    notBefore,
    deadlineAt,
  };
  const fingerprint = `sha256:${sha256(stableJson(event))}`;
  const coalesceKey = `coalesce:${sha256(stableJson(eventCoalesceMaterial(event)))}`;
  return Object.freeze({
    ...event,
    eventId: `management-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 32)}`,
    fingerprint,
    coalesceKey,
  });
}

function eventFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    schemaVersion: Number(row.schema_version),
    eventId: row.event_id,
    fingerprint: row.fingerprint,
    coalesceKey: row.coalesce_key,
    eventType: row.event_type,
    projectId: row.project_id,
    repository: row.repo,
    issueNumber: row.issue_number,
    pullRequestNumber: row.pull_request_number,
    sha: row.exact_sha,
    correlationId: row.correlation_id,
    predecessorEventId: row.predecessor_event_id,
    notBefore: row.not_before,
    deadlineAt: row.deadline_at,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    claimExpiresAt: row.claim_expires_at,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    settledAt: row.settled_at,
  });
}

function claimTokenHash(claimToken) {
  if (typeof claimToken !== 'string' || !CLAIM_TOKEN_PATTERN.test(claimToken)) {
    throw new Error('management event claim token is invalid');
  }
  return sha256(claimToken);
}

function normalizedOutcome(value) {
  if (typeof value !== 'string' || !OUTCOME_PATTERN.test(value)) {
    throw new Error('management event outcome is invalid');
  }
  return value;
}

export class ManagementEventStore {
  constructor(dbPath, {
    registry,
    now = () => new Date().toISOString(),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = {}) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) throw new Error('management event db path is required');
    if (!registry || !isObject(registry)) throw new Error('management event project registry is required');
    this.dbPath = dbPath;
    this.registry = registry;
    this.now = now;
    this.maxAttempts = boundedInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, {
      name: 'management event maxAttempts', min: 1, max: 20,
    });
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS management_event_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS management_events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        coalesce_key TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'programme-reconcile-required',
          'execution-reconcile-required',
          'queue-assurance-required',
          'delayed-event-ready'
        )),
        project_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER,
        pull_request_number INTEGER,
        exact_sha TEXT,
        correlation_id TEXT NOT NULL,
        predecessor_event_id TEXT,
        not_before TEXT NOT NULL,
        deadline_at TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'settled', 'blocked', 'dead-letter')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        claim_token_hash TEXT,
        claim_expires_at TEXT,
        outcome TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_at TEXT,
        settled_at TEXT,
        FOREIGN KEY (predecessor_event_id) REFERENCES management_events(event_id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS management_events_one_active_scope_idx
        ON management_events(coalesce_key)
        WHERE state IN ('pending', 'claimed');

      CREATE INDEX IF NOT EXISTS management_events_due_idx
        ON management_events(state, not_before, created_at, event_id);

      CREATE INDEX IF NOT EXISTS management_events_correlation_idx
        ON management_events(project_id, correlation_id, created_at, event_id);
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO management_event_schema(version, applied_at)
      VALUES (?, ?)
    `).run(MANAGEMENT_EVENT_SCHEMA_VERSION, this.now());
    const schema = this.db.prepare('SELECT MAX(version) AS version FROM management_event_schema').get();
    if (Number(schema?.version) !== MANAGEMENT_EVENT_SCHEMA_VERSION) {
      throw new Error(`unsupported management event schema version: ${String(schema?.version ?? 'missing')}`);
    }
  }

  getEvent(eventId) {
    if (typeof eventId !== 'string' || eventId.length === 0) throw new Error('management event eventId is required');
    return eventFromRow(this.db.prepare('SELECT * FROM management_events WHERE event_id = ?').get(eventId));
  }

  listEvents({ states = MANAGEMENT_EVENT_STATES, limit = 100 } = {}) {
    if (!Array.isArray(states) || states.length === 0 || states.some((state) => !MANAGEMENT_EVENT_STATES.includes(state))) {
      throw new Error('management event states are invalid');
    }
    const boundedLimit = boundedInteger(limit, 100, { name: 'management event list limit', min: 1, max: 500 });
    const placeholders = states.map(() => '?').join(', ');
    return Object.freeze(this.db.prepare(`
      SELECT * FROM management_events
      WHERE state IN (${placeholders})
      ORDER BY created_at ASC, event_id ASC
      LIMIT ?
    `).all(...states, boundedLimit).map(eventFromRow));
  }

  enqueue(input, { now = this.now() } = {}) {
    const normalized = normalizeManagementEvent(input, { registry: this.registry, now });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.enqueueInTransaction(normalized, { now });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  enqueueInTransaction(normalizedOrInput, { now = this.now() } = {}) {
    const event = normalizedOrInput?.fingerprint
      ? normalizedOrInput
      : normalizeManagementEvent(normalizedOrInput, { registry: this.registry, now });
    if (event.predecessorEventId && !this.getEvent(event.predecessorEventId)) {
      throw new Error(`management event predecessor does not exist: ${event.predecessorEventId}`);
    }

    const replay = this.db.prepare('SELECT * FROM management_events WHERE fingerprint = ?').get(event.fingerprint);
    if (replay) return Object.freeze({ inserted: false, duplicate: true, coalesced: false, event: eventFromRow(replay) });

    const placeholders = ACTIVE_EVENT_STATES.map(() => '?').join(', ');
    const active = this.db.prepare(`
      SELECT * FROM management_events
      WHERE coalesce_key = ? AND state IN (${placeholders})
      ORDER BY created_at ASC, event_id ASC
      LIMIT 1
    `).get(event.coalesceKey, ...ACTIVE_EVENT_STATES);
    if (active) return Object.freeze({ inserted: false, duplicate: false, coalesced: true, event: eventFromRow(active) });

    const timestamp = iso(now, 'management event enqueue timestamp');
    this.db.prepare(`
      INSERT INTO management_events(
        event_id, schema_version, fingerprint, coalesce_key, event_type,
        project_id, repo, issue_number, pull_request_number, exact_sha,
        correlation_id, predecessor_event_id, not_before, deadline_at,
        state, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      event.eventId,
      event.schemaVersion,
      event.fingerprint,
      event.coalesceKey,
      event.eventType,
      event.projectId,
      event.repository,
      event.issueNumber,
      event.pullRequestNumber,
      event.sha,
      event.correlationId,
      event.predecessorEventId,
      event.notBefore,
      event.deadlineAt,
      timestamp,
      timestamp,
    );
    return Object.freeze({ inserted: true, duplicate: false, coalesced: false, event: this.getEvent(event.eventId) });
  }

  expireInTransaction(now) {
    const timestamp = iso(now, 'management event recovery timestamp');
    const expiredClaims = this.db.prepare(`
      SELECT event_id, attempt_count FROM management_events
      WHERE state = 'claimed' AND claim_expires_at <= ?
      ORDER BY claim_expires_at ASC, event_id ASC
    `).all(timestamp);
    let requeued = 0;
    let deadLettered = 0;
    for (const row of expiredClaims) {
      if (Number(row.attempt_count) >= this.maxAttempts) {
        const result = this.db.prepare(`
          UPDATE management_events
          SET state = 'dead-letter', claim_expires_at = NULL,
              outcome = 'lease-attempts-exhausted', settled_at = ?, updated_at = ?
          WHERE event_id = ? AND state = 'claimed'
        `).run(timestamp, timestamp, row.event_id);
        deadLettered += Number(result.changes);
      } else {
        const result = this.db.prepare(`
          UPDATE management_events
          SET state = 'pending', claim_token_hash = NULL, claim_expires_at = NULL,
              claimed_at = NULL, outcome = 'lease-expired', updated_at = ?
          WHERE event_id = ? AND state = 'claimed'
        `).run(timestamp, row.event_id);
        requeued += Number(result.changes);
      }
    }

    const deadlineResult = this.db.prepare(`
      UPDATE management_events
      SET state = 'blocked', outcome = 'deadline-expired', settled_at = ?, updated_at = ?
      WHERE state = 'pending' AND deadline_at IS NOT NULL AND deadline_at <= ?
    `).run(timestamp, timestamp, timestamp);

    const attemptResult = this.db.prepare(`
      UPDATE management_events
      SET state = 'dead-letter', outcome = 'attempts-exhausted', settled_at = ?, updated_at = ?
      WHERE state = 'pending' AND attempt_count >= ?
    `).run(timestamp, timestamp, this.maxAttempts);

    return Object.freeze({
      requeued,
      deadLettered: deadLettered + Number(attemptResult.changes),
      deadlineBlocked: Number(deadlineResult.changes),
    });
  }

  recoverExpiredClaims({ now = this.now() } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.expireInTransaction(now);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listDue({ now = this.now(), limit = 100 } = {}) {
    const timestamp = iso(now, 'management event due timestamp');
    const boundedLimit = boundedInteger(limit, 100, { name: 'management event due limit', min: 1, max: MAX_DUE_SCAN });
    return Object.freeze(this.db.prepare(`
      SELECT * FROM management_events
      WHERE state = 'pending'
        AND attempt_count < ?
        AND not_before <= ?
        AND (deadline_at IS NULL OR deadline_at > ?)
      ORDER BY not_before ASC, created_at ASC, event_id ASC
      LIMIT ?
    `).all(this.maxAttempts, timestamp, timestamp, boundedLimit).map(eventFromRow));
  }

  recoverDueEvents({ now = this.now(), limit = 100 } = {}) {
    const boundedLimit = boundedInteger(limit, 100, { name: 'management event recovery limit', min: 1, max: MAX_DUE_SCAN });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const recovery = this.expireInTransaction(now);
      const due = this.listDue({ now, limit: boundedLimit });
      this.db.exec('COMMIT');
      return Object.freeze({ recovery, due });
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimNext({
    claimToken,
    leaseMs = DEFAULT_LEASE_MS,
    now = this.now(),
  } = {}) {
    const tokenHash = claimTokenHash(claimToken);
    const boundedLeaseMs = boundedInteger(leaseMs, DEFAULT_LEASE_MS, {
      name: 'management event leaseMs', min: 1_000, max: 60 * 60_000,
    });
    const timestamp = iso(now, 'management event claim timestamp');
    const expiresAt = new Date(Date.parse(timestamp) + boundedLeaseMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expireInTransaction(timestamp);
      const candidate = this.db.prepare(`
        SELECT event_id FROM management_events
        WHERE state = 'pending'
          AND attempt_count < ?
          AND not_before <= ?
          AND (deadline_at IS NULL OR deadline_at > ?)
        ORDER BY not_before ASC, created_at ASC, event_id ASC
        LIMIT 1
      `).get(this.maxAttempts, timestamp, timestamp);
      if (!candidate) {
        this.db.exec('COMMIT');
        return null;
      }
      const result = this.db.prepare(`
        UPDATE management_events
        SET state = 'claimed', attempt_count = attempt_count + 1,
            claim_token_hash = ?, claim_expires_at = ?, claimed_at = ?,
            outcome = NULL, updated_at = ?
        WHERE event_id = ? AND state = 'pending'
      `).run(tokenHash, expiresAt, timestamp, timestamp, candidate.event_id);
      if (Number(result.changes) !== 1) throw new Error('management event claim lost its deterministic candidate');
      const claimed = this.getEvent(candidate.event_id);
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  settle(eventId, {
    claimToken,
    state = 'settled',
    outcome = 'completed',
    successors = [],
    now = this.now(),
  } = {}) {
    if (!['settled', 'blocked'].includes(state)) throw new Error('management event settlement state is invalid');
    if (!Array.isArray(successors) || successors.length > 20) throw new Error('management event successors exceed the bounded limit');
    const tokenHash = claimTokenHash(claimToken);
    const normalizedResult = normalizedOutcome(outcome);
    const timestamp = iso(now, 'management event settlement timestamp');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentRow = this.db.prepare('SELECT * FROM management_events WHERE event_id = ?').get(eventId);
      if (!currentRow) throw new Error(`unknown management event: ${eventId}`);
      if (currentRow.state === state && currentRow.settled_at && currentRow.claim_token_hash === tokenHash) {
        const event = eventFromRow(currentRow);
        this.db.exec('COMMIT');
        return Object.freeze({ event, successors: Object.freeze([]), idempotent: true });
      }
      if (currentRow.state !== 'claimed' || currentRow.claim_token_hash !== tokenHash) {
        throw new Error('management event is not claimed by this claimant');
      }

      this.db.prepare(`
        UPDATE management_events
        SET state = ?, outcome = ?, claim_expires_at = NULL,
            settled_at = ?, updated_at = ?
        WHERE event_id = ? AND state = 'claimed' AND claim_token_hash = ?
      `).run(state, normalizedResult, timestamp, timestamp, eventId, tokenHash);

      const parent = eventFromRow(this.db.prepare('SELECT * FROM management_events WHERE event_id = ?').get(eventId));
      const successorResults = [];
      for (const successor of successors) {
        if (!isObject(successor)) throw new Error('management event successor must be an object');
        const normalized = normalizeManagementEvent({
          ...successor,
          projectId: successor.projectId ?? parent.projectId,
          repository: successor.repository ?? parent.repository,
          correlationId: successor.correlationId ?? parent.correlationId,
          predecessorEventId: successor.predecessorEventId ?? parent.eventId,
        }, { registry: this.registry, now: timestamp });
        successorResults.push(this.enqueueInTransaction(normalized, { now: timestamp }));
      }
      this.db.exec('COMMIT');
      return Object.freeze({
        event: this.getEvent(eventId),
        successors: Object.freeze(successorResults),
        idempotent: false,
      });
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

function boundedWakeError(error) {
  const code = typeof error?.code === 'string' && OUTCOME_PATTERN.test(error.code)
    ? error.code
    : 'wake-failed';
  return Object.freeze({ attempted: true, ok: false, errorCode: code });
}

function callWake(wake, payload) {
  if (typeof wake !== 'function') return Object.freeze({ attempted: false, ok: true, errorCode: null });
  try {
    wake(Object.freeze(payload));
    return Object.freeze({ attempted: true, ok: true, errorCode: null });
  } catch (error) {
    return boundedWakeError(error);
  }
}

export function enqueueManagementEventAndWake({
  store,
  event,
  wake,
  now,
} = {}) {
  if (!(store instanceof ManagementEventStore)) throw new Error('management event store is required');
  const result = store.enqueue(event, { now: now ?? store.now() });
  const current = result.event;
  const due = current.state === 'pending' && Date.parse(current.notBefore) <= Date.parse(now ?? store.now());
  const wakeResult = due
    ? callWake(wake, { schemaVersion: 1, reason: 'management-event-due', eventId: current.eventId })
    : Object.freeze({ attempted: false, ok: true, errorCode: null });
  return Object.freeze({ ...result, wake: wakeResult });
}

export function recoverDueManagementEvents({
  store,
  wake,
  now,
  limit = 100,
} = {}) {
  if (!(store instanceof ManagementEventStore)) throw new Error('management event store is required');
  const result = store.recoverDueEvents({ now: now ?? store.now(), limit });
  const wakeResult = result.due.length > 0
    ? callWake(wake, { schemaVersion: 1, reason: 'management-event-recovery', dueCount: result.due.length })
    : Object.freeze({ attempted: false, ok: true, errorCode: null });
  return Object.freeze({ ...result, wake: wakeResult });
}
