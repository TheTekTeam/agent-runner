import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const EVENT_SETTLEMENT_SCHEMA_VERSION = 1;
export const DEFAULT_EVENT_DEBOUNCE_MS = 60_000;
export const DEFAULT_CHECK_QUIET_PERIOD_MS = 90_000;
export const DEFAULT_SETTLEMENT_TIMEOUT_MS = 60 * 60_000;

export const BATCH_STATES = Object.freeze([
  'collecting',
  'waiting_for_checks',
  'quiet_period',
  'settled',
  'settlement_blocked',
]);

const ACTIVE_BATCH_STATES = Object.freeze([
  'collecting',
  'waiting_for_checks',
  'quiet_period',
  'settlement_blocked',
]);

const NON_TERMINAL_CHECK_STATES = new Set([
  'queued', 'requested', 'waiting', 'pending', 'in_progress',
]);

const TERMINAL_CHECK_CONCLUSIONS = new Set([
  'success', 'failure', 'cancelled', 'timed_out', 'action_required',
  'neutral', 'skipped', 'stale', 'startup_failure', 'error',
]);

const REQUIRED_SHA_ROLES = new Set(['head', 'merge', 'after']);
const HEX_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid timestamp: ${String(value)}`);
  }
  return new Date(value).toISOString();
}

function milliseconds(value, name, { min = 0, max = 24 * 60 * 60_000 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function sha(value) {
  return typeof value === 'string' && HEX_SHA_PATTERN.test(value) ? value.toLowerCase() : null;
}

function batchObject(envelope) {
  if (!envelope?.projectId || !envelope?.repository) return null;
  if (Number.isInteger(envelope.pullRequestNumber) && envelope.pullRequestNumber > 0) {
    return { kind: 'pull_request', number: envelope.pullRequestNumber };
  }
  if (Number.isInteger(envelope.issueNumber) && envelope.issueNumber > 0) {
    return { kind: 'issue', number: envelope.issueNumber };
  }
  return { kind: 'repository', number: null };
}

export function settlementBatchKey(envelope) {
  const object = batchObject(envelope);
  if (!object) return null;
  return [envelope.projectId, envelope.repository.toLowerCase(), object.kind, object.number ?? '-'].join(':');
}

function deterministicBatchId(batchKey, deliveryId, createdAt) {
  return `batch-${createHash('sha256').update(`${batchKey}\n${deliveryId}\n${createdAt}`).digest('hex').slice(0, 24)}`;
}

function canonicalCheck(check, index) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    throw new Error(`checks[${index}] must be an object`);
  }
  const provider = typeof check.provider === 'string' && check.provider ? check.provider.slice(0, 64) : 'unknown';
  const externalId = String(check.externalId ?? check.id ?? `${provider}-${index}`).slice(0, 255);
  const name = String(check.name ?? externalId).slice(0, 255);
  const status = String(check.status ?? '').toLowerCase().slice(0, 64);
  const conclusion = check.conclusion == null ? null : String(check.conclusion).toLowerCase().slice(0, 64);

  let terminal;
  if (NON_TERMINAL_CHECK_STATES.has(status)) terminal = false;
  else if (status === 'completed') terminal = TERMINAL_CHECK_CONCLUSIONS.has(conclusion);
  else if (TERMINAL_CHECK_CONCLUSIONS.has(status)) terminal = true;
  else terminal = false;

  return Object.freeze({ provider, externalId, name, status, conclusion, terminal });
}

export function normalizeCheckSnapshot({ sha: inputSha, observedAt, queryComplete = true, checks = [] }) {
  const normalizedSha = sha(inputSha);
  if (!normalizedSha) throw new Error('check snapshot sha is required');
  if (!Array.isArray(checks)) throw new Error('check snapshot checks must be an array');
  if (checks.length > 1_000) throw new Error('check snapshot checks exceed the bounded limit');
  if (typeof queryComplete !== 'boolean') throw new Error('check snapshot queryComplete must be boolean');
  const normalizedChecks = checks.map(canonicalCheck).sort((left, right) => (
    `${left.provider}:${left.externalId}`.localeCompare(`${right.provider}:${right.externalId}`)
  ));
  const checkKeys = new Set();
  for (const check of normalizedChecks) {
    const key = `${check.provider}:${check.externalId}`;
    if (checkKeys.has(key)) throw new Error(`check snapshot contains duplicate check identity: ${key}`);
    checkKeys.add(key);
  }
  const normalized = {
    sha: normalizedSha,
    observedAt: iso(observedAt),
    queryComplete,
    checks: normalizedChecks,
  };
  normalized.fingerprint = createHash('sha256').update(JSON.stringify({
    sha: normalized.sha,
    queryComplete: normalized.queryComplete,
    checks: normalized.checks,
  })).digest('hex');
  return Object.freeze(normalized);
}

function checkSnapshotSummary(snapshot) {
  const nonTerminal = snapshot.checks.filter((check) => !check.terminal);
  const terminalFailures = snapshot.checks.flatMap((check) => {
    if (!check.terminal) return [];
    const outcome = check.conclusion ?? (TERMINAL_CHECK_CONCLUSIONS.has(check.status) ? check.status : null);
    return outcome && outcome !== 'success' ? [{ ...check, outcome }] : [];
  });
  return { nonTerminal, terminalFailures };
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function combinedSnapshotFingerprint(snapshots) {
  return createHash('sha256').update(JSON.stringify(
    snapshots.map((snapshot) => ({ sha: snapshot.sha, fingerprint: snapshot.fingerprint })),
  )).digest('hex');
}

export class EventSettlementStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) throw new Error('event settlement db path is required');
    this.dbPath = dbPath;
    this.now = now;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS event_settlement_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_batches (
        batch_id TEXT PRIMARY KEY,
        batch_key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        object_kind TEXT NOT NULL CHECK (object_kind IN ('pull_request', 'issue', 'repository')),
        object_number INTEGER,
        state TEXT NOT NULL CHECK (state IN (
          'collecting', 'waiting_for_checks', 'quiet_period', 'settled', 'settlement_blocked'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        first_event_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        quiet_started_at TEXT,
        deadline_at TEXT NOT NULL,
        settled_at TEXT,
        result_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS event_batches_active_idx
        ON event_batches(batch_key, state, updated_at);

      CREATE UNIQUE INDEX IF NOT EXISTS event_batches_one_active_key_idx
        ON event_batches(batch_key)
        WHERE state IN ('collecting', 'waiting_for_checks', 'quiet_period', 'settlement_blocked');

      CREATE TABLE IF NOT EXISTS event_batch_deliveries (
        batch_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL UNIQUE,
        attached_at TEXT NOT NULL,
        PRIMARY KEY (batch_id, delivery_id),
        FOREIGN KEY (batch_id) REFERENCES event_batches(batch_id) ON DELETE CASCADE,
        FOREIGN KEY (delivery_id) REFERENCES webhook_deliveries(delivery_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS event_batch_shas (
        batch_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('head', 'base', 'merge', 'before', 'after')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (batch_id, sha, role),
        FOREIGN KEY (batch_id) REFERENCES event_batches(batch_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS event_check_snapshots (
        batch_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        query_complete INTEGER NOT NULL CHECK (query_complete IN (0, 1)),
        fingerprint TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        PRIMARY KEY (batch_id, sha),
        FOREIGN KEY (batch_id) REFERENCES event_batches(batch_id) ON DELETE CASCADE
      );
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO event_settlement_schema(version, applied_at)
      VALUES (?, ?)
    `).run(EVENT_SETTLEMENT_SCHEMA_VERSION, this.now());
  }

  getDelivery(deliveryId) {
    const row = this.db.prepare(`
      SELECT delivery_id, received_at, project_id, repo, event_name, action,
             issue_number, pull_request_number, head_sha, base_sha, merge_sha,
             payload_sha256, processing_state, updated_at, event_json
      FROM webhook_deliveries
      WHERE delivery_id = ?
    `).get(deliveryId);
    if (!row) return null;
    return {
      deliveryId: row.delivery_id,
      receivedAt: row.received_at,
      projectId: row.project_id,
      repository: row.repo,
      eventName: row.event_name,
      action: row.action,
      issueNumber: row.issue_number,
      pullRequestNumber: row.pull_request_number,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      mergeSha: row.merge_sha,
      processingState: row.processing_state,
      event: parseJson(row.event_json, {}),
    };
  }

  pendingDeliveryIds({ limit = 200 } = {}) {
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200;
    return this.db.prepare(`
      SELECT delivery_id
      FROM webhook_deliveries
      WHERE processing_state = 'pending'
      ORDER BY received_at ASC, delivery_id ASC
      LIMIT ?
    `).all(boundedLimit).map((row) => row.delivery_id);
  }

  activeBatch(batchKey) {
    const placeholders = ACTIVE_BATCH_STATES.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT batch_id
      FROM event_batches
      WHERE batch_key = ? AND state IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT 1
    `).get(batchKey, ...ACTIVE_BATCH_STATES)?.batch_id ?? null;
  }

  correlatedActiveBatch(delivery) {
    const candidates = [...new Set([
      delivery.event.headSha,
      delivery.event.mergeSha,
      delivery.event.afterSha,
    ].map(sha).filter(Boolean))];
    if (candidates.length === 0 || !delivery.projectId || !delivery.repository) return null;
    const statePlaceholders = ACTIVE_BATCH_STATES.map(() => '?').join(', ');
    const shaPlaceholders = candidates.map(() => '?').join(', ');
    const row = this.db.prepare(`
      SELECT DISTINCT batch.batch_id, batch.batch_key
      FROM event_batches AS batch
      JOIN event_batch_shas AS tracked ON tracked.batch_id = batch.batch_id
      WHERE batch.project_id = ?
        AND lower(batch.repo) = lower(?)
        AND batch.object_kind = 'pull_request'
        AND batch.state IN (${statePlaceholders})
        AND tracked.sha IN (${shaPlaceholders})
      ORDER BY batch.created_at DESC
      LIMIT 1
    `).get(
      delivery.projectId,
      delivery.repository,
      ...ACTIVE_BATCH_STATES,
      ...candidates,
    );
    return row ? { batchId: row.batch_id, batchKey: row.batch_key } : null;
  }

  attachPendingDeliveries({
    now = this.now(),
    settlementTimeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS,
    limit = 200,
  } = {}) {
    const attached = [];
    for (const deliveryId of this.pendingDeliveryIds({ limit })) {
      const result = this.attachDelivery(deliveryId, { now, settlementTimeoutMs });
      if (result) attached.push(result);
    }
    return attached;
  }

  attachDelivery(deliveryId, options = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.attachDeliveryInTransaction(deliveryId, options);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  attachDeliveryInTransaction(deliveryId, {
    now = this.now(),
    settlementTimeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS,
  } = {}) {
    const timestamp = iso(now);
    milliseconds(settlementTimeoutMs, 'settlementTimeoutMs', { min: 1_000, max: 24 * 60 * 60_000 });
    const delivery = this.getDelivery(deliveryId);
    if (!delivery) throw new Error(`unknown webhook delivery: ${deliveryId}`);
    if (delivery.processingState !== 'pending') return null;

    const ownBatchKey = settlementBatchKey(delivery.event);
    if (!ownBatchKey) {
      this.db.prepare(`
        UPDATE webhook_deliveries SET processing_state = 'processed', updated_at = ?
        WHERE delivery_id = ? AND processing_state = 'pending'
      `).run(timestamp, deliveryId);
      return { deliveryId, ignored: true, reason: 'non-project-event' };
    }

    const correlation = batchObject(delivery.event)?.kind === 'repository'
      ? this.correlatedActiveBatch(delivery)
      : null;
    const batchKey = correlation?.batchKey ?? ownBatchKey;
    let batchId = correlation?.batchId ?? this.activeBatch(batchKey);
    const active = batchId ? this.getBatch(batchId) : null;
    const object = active
      ? { kind: active.objectKind, number: active.objectNumber }
      : batchObject(delivery.event);
    const eventReceivedAt = iso(delivery.receivedAt);
    if (!batchId) {
      batchId = deterministicBatchId(batchKey, deliveryId, timestamp);
      this.db.prepare(`
        INSERT INTO event_batches(
          batch_id, batch_key, project_id, repo, object_kind, object_number,
          state, created_at, updated_at, first_event_at, last_event_at, deadline_at, result_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'collecting', ?, ?, ?, ?, ?, '{}')
      `).run(
        batchId,
        batchKey,
        delivery.projectId,
        delivery.repository,
        object.kind,
        object.number,
        timestamp,
        timestamp,
        eventReceivedAt,
        eventReceivedAt,
        new Date(Date.parse(timestamp) + settlementTimeoutMs).toISOString(),
      );
    } else {
      this.db.prepare(`
        UPDATE event_batches
        SET state = 'collecting', updated_at = ?,
            last_event_at = CASE WHEN last_event_at > ? THEN last_event_at ELSE ? END,
            quiet_started_at = NULL, settled_at = NULL,
            deadline_at = ?, result_json = '{}'
        WHERE batch_id = ?
      `).run(
        timestamp,
        eventReceivedAt,
        eventReceivedAt,
        new Date(Date.parse(timestamp) + settlementTimeoutMs).toISOString(),
        batchId,
      );
    }

    const attached = this.db.prepare(`
      INSERT OR IGNORE INTO event_batch_deliveries(batch_id, delivery_id, attached_at)
      VALUES (?, ?, ?)
    `).run(batchId, deliveryId, timestamp);
    if (Number(attached.changes) !== 1) return null;

    const shas = [
      ['head', delivery.event.headSha],
      ['base', delivery.event.baseSha],
      ['merge', delivery.event.mergeSha],
      ['before', delivery.event.beforeSha],
      ['after', delivery.event.afterSha],
    ];
    const upsertSha = this.db.prepare(`
      INSERT INTO event_batch_shas(batch_id, sha, role, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(batch_id, sha, role) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `);
    for (const [role, value] of shas) {
      const normalized = sha(value);
      if (normalized) upsertSha.run(batchId, normalized, role, timestamp, timestamp);
    }

    this.db.prepare(`
      UPDATE webhook_deliveries SET processing_state = 'batched', updated_at = ?
      WHERE delivery_id = ? AND processing_state = 'pending'
    `).run(timestamp, deliveryId);
    return { deliveryId, batchId, batchKey, ignored: false };
  }

  getBatch(batchId) {
    const row = this.db.prepare(`SELECT * FROM event_batches WHERE batch_id = ?`).get(batchId);
    if (!row) return null;
    const shas = this.db.prepare(`
      SELECT sha, role, first_seen_at, last_seen_at
      FROM event_batch_shas WHERE batch_id = ? ORDER BY role, sha
    `).all(batchId).map((item) => ({
      sha: item.sha,
      role: item.role,
      firstSeenAt: item.first_seen_at,
      lastSeenAt: item.last_seen_at,
    }));
    const deliveries = this.db.prepare(`
      SELECT mapping.delivery_id
      FROM event_batch_deliveries AS mapping
      JOIN webhook_deliveries AS delivery ON delivery.delivery_id = mapping.delivery_id
      WHERE mapping.batch_id = ?
      ORDER BY delivery.received_at, mapping.delivery_id
    `).all(batchId).map((item) => item.delivery_id);
    return {
      batchId: row.batch_id,
      batchKey: row.batch_key,
      projectId: row.project_id,
      repository: row.repo,
      objectKind: row.object_kind,
      objectNumber: row.object_number,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      firstEventAt: row.first_event_at,
      lastEventAt: row.last_event_at,
      quietStartedAt: row.quiet_started_at,
      deadlineAt: row.deadline_at,
      settledAt: row.settled_at,
      result: parseJson(row.result_json, {}),
      shas,
      deliveries,
    };
  }

  requiredShas(batchId) {
    const rows = this.db.prepare(`
      SELECT candidate.sha, candidate.role
      FROM event_batch_shas AS candidate
      WHERE candidate.batch_id = ?
        AND candidate.role IN ('head', 'merge', 'after')
        AND candidate.last_seen_at = (
          SELECT MAX(current.last_seen_at)
          FROM event_batch_shas AS current
          WHERE current.batch_id = candidate.batch_id AND current.role = candidate.role
        )
      ORDER BY candidate.role, candidate.sha
    `).all(batchId);
    return [...new Set(rows.filter((row) => REQUIRED_SHA_ROLES.has(row.role)).map((row) => row.sha))];
  }

  recordCheckSnapshot(batchId, input) {
    const batch = this.getBatch(batchId);
    if (!batch) throw new Error(`unknown event batch: ${batchId}`);
    const snapshot = normalizeCheckSnapshot(input);
    if (!this.requiredShas(batchId).includes(snapshot.sha)) {
      throw new Error(`check snapshot sha is not tracked by batch: ${snapshot.sha}`);
    }
    this.db.prepare(`
      INSERT INTO event_check_snapshots(batch_id, sha, observed_at, query_complete, fingerprint, checks_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id, sha) DO UPDATE SET
        observed_at = excluded.observed_at,
        query_complete = excluded.query_complete,
        fingerprint = excluded.fingerprint,
        checks_json = excluded.checks_json
      WHERE excluded.observed_at >= event_check_snapshots.observed_at
    `).run(
      batchId,
      snapshot.sha,
      snapshot.observedAt,
      snapshot.queryComplete ? 1 : 0,
      snapshot.fingerprint,
      JSON.stringify(snapshot.checks),
    );
    return snapshot;
  }

  snapshots(batchId) {
    return this.db.prepare(`
      SELECT sha, observed_at, query_complete, fingerprint, checks_json
      FROM event_check_snapshots WHERE batch_id = ? ORDER BY sha
    `).all(batchId).map((row) => ({
      sha: row.sha,
      observedAt: row.observed_at,
      queryComplete: row.query_complete === 1,
      fingerprint: row.fingerprint,
      checks: parseJson(row.checks_json, []),
    }));
  }

  updateBatchState(batchId, state, { now, quietStartedAt = null, settledAt = null, result = {} } = {}) {
    if (!BATCH_STATES.includes(state)) throw new Error(`invalid batch state: ${state}`);
    const timestamp = iso(now ?? this.now());
    const settledGuard = state === 'settled' ? '' : " AND state <> 'settled'";
    this.db.prepare(`
      UPDATE event_batches
      SET state = ?, updated_at = ?, quiet_started_at = ?, settled_at = ?, result_json = ?
      WHERE batch_id = ?${settledGuard}
    `).run(state, timestamp, quietStartedAt, settledAt, JSON.stringify(result), batchId);
    return this.getBatch(batchId);
  }

  evaluateBatch(batchId, {
    now = this.now(),
    debounceMs = DEFAULT_EVENT_DEBOUNCE_MS,
    quietPeriodMs = DEFAULT_CHECK_QUIET_PERIOD_MS,
  } = {}) {
    const timestamp = iso(now);
    milliseconds(debounceMs, 'debounceMs', { max: 60 * 60_000 });
    milliseconds(quietPeriodMs, 'quietPeriodMs', { max: 60 * 60_000 });
    const nowMs = Date.parse(timestamp);
    const batch = this.getBatch(batchId);
    if (!batch) throw new Error(`unknown event batch: ${batchId}`);
    if (batch.state === 'settled') return batch;

    if (nowMs < Date.parse(batch.lastEventAt) + debounceMs) {
      return this.updateBatchState(batchId, 'collecting', {
        now: timestamp,
        result: { reason: 'event-debounce-active' },
      });
    }

    const requiredShas = this.requiredShas(batchId);
    const snapshots = this.snapshots(batchId).filter((snapshot) => requiredShas.includes(snapshot.sha));
    const bySha = new Map(snapshots.map((snapshot) => [snapshot.sha, snapshot]));
    const missingShas = requiredShas.filter((value) => !bySha.has(value));
    const incompleteShas = snapshots.filter((snapshot) => !snapshot.queryComplete).map((snapshot) => snapshot.sha);
    const nonTerminalChecks = snapshots.flatMap((snapshot) => (
      checkSnapshotSummary(snapshot).nonTerminal.map((check) => ({ sha: snapshot.sha, ...check }))
    ));
    const terminalFailures = snapshots.flatMap((snapshot) => (
      checkSnapshotSummary(snapshot).terminalFailures.map((check) => ({ sha: snapshot.sha, ...check }))
    ));
    const deadlineReached = nowMs >= Date.parse(batch.deadlineAt);

    if (missingShas.length > 0 || incompleteShas.length > 0 || nonTerminalChecks.length > 0) {
      const evidence = { missingShas, incompleteShas, nonTerminalChecks, terminalFailures };
      if (deadlineReached) {
        return this.updateBatchState(batchId, 'settlement_blocked', {
          now: timestamp,
          result: { reason: 'ci-settlement-timeout', ...evidence },
        });
      }
      return this.updateBatchState(batchId, 'waiting_for_checks', {
        now: timestamp,
        result: { reason: 'ci-not-terminal', ...evidence },
      });
    }

    const fingerprint = combinedSnapshotFingerprint(snapshots);
    const priorFingerprint = batch.result?.quietFingerprint ?? null;
    if (!batch.quietStartedAt || priorFingerprint !== fingerprint) {
      return this.updateBatchState(batchId, 'quiet_period', {
        now: timestamp,
        quietStartedAt: timestamp,
        result: {
          reason: batch.quietStartedAt ? 'check-set-changed' : 'checks-terminal-awaiting-final-recheck',
          quietFingerprint: fingerprint,
          requiredShas,
          terminalFailures,
        },
      });
    }

    const quietDeadline = Date.parse(batch.quietStartedAt) + quietPeriodMs;
    const finalRecheckComplete = requiredShas.length === 0
      || requiredShas.every((value) => Date.parse(bySha.get(value).observedAt) >= quietDeadline);
    if (nowMs < quietDeadline || !finalRecheckComplete) {
      if (deadlineReached) {
        return this.updateBatchState(batchId, 'settlement_blocked', {
          now: timestamp,
          quietStartedAt: batch.quietStartedAt,
          result: {
            reason: 'final-recheck-timeout',
            quietFingerprint: fingerprint,
            requiredShas,
            terminalFailures,
          },
        });
      }
      return this.updateBatchState(batchId, 'quiet_period', {
        now: timestamp,
        quietStartedAt: batch.quietStartedAt,
        result: {
          reason: finalRecheckComplete ? 'quiet-period-active' : 'final-recheck-required',
          quietFingerprint: fingerprint,
          requiredShas,
          terminalFailures,
        },
      });
    }

    const result = {
      reason: 'ci-settled',
      quietFingerprint: fingerprint,
      requiredShas,
      terminalFailures,
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE webhook_deliveries
        SET processing_state = 'processed', updated_at = ?
        WHERE delivery_id IN (
          SELECT delivery_id FROM event_batch_deliveries WHERE batch_id = ?
        )
      `).run(timestamp, batchId);
      this.db.prepare(`
        UPDATE event_batches
        SET state = 'settled', updated_at = ?, quiet_started_at = ?,
            settled_at = ?, result_json = ?
        WHERE batch_id = ? AND state <> 'settled'
      `).run(timestamp, batch.quietStartedAt, timestamp, JSON.stringify(result), batchId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getBatch(batchId);
  }

  close() {
    this.db.close();
  }
}
