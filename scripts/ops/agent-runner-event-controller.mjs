import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { refreshBatchGitHubCheckSnapshots } from './agent-runner-github-checks-provider.mjs';
import { projectFromRegistryByRepository } from './agent-runner-project-registry.mjs';

export const EVENT_CONTROLLER_SCHEMA_VERSION = 1;
export const TRIAGE_RELEASE_STATES = Object.freeze(['pending', 'claimed', 'processed', 'failed']);
const ACTIVE_BATCH_STATES = Object.freeze(['collecting', 'waiting_for_checks', 'quiet_period', 'settlement_blocked']);
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_CONTROLLER_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const CONTROLLER_SNAPSHOT_ATTEMPTS = 8;

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid timestamp: ${String(value)}`);
  return date.toISOString();
}

function boundedInteger(value, fallback, { min, max, name }) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function boundedErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : 'controller-batch-failed';
  return /^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(code) ? code : 'controller-batch-failed';
}

function releasePayload(batch) {
  return Object.freeze({
    schemaVersion: 1,
    batchId: batch.batchId,
    projectId: batch.projectId,
    repository: batch.repository,
    objectKind: batch.objectKind,
    objectNumber: batch.objectNumber,
    settledAt: batch.settledAt,
    deliveryIds: Object.freeze([...batch.deliveries]),
    shas: Object.freeze(batch.shas.map(({ sha, role }) => ({ sha, role }))),
    settlement: Object.freeze({
      reason: batch.result?.reason ?? null,
      requiredShas: Object.freeze([...(batch.result?.requiredShas ?? [])]),
      terminalFailures: Object.freeze([...(batch.result?.terminalFailures ?? [])]),
    }),
  });
}

function parseReleaseJson(value, name) {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new Error(`${name} contains invalid JSON object`);
  }
}

function releaseFromRow(row, { freeze = false, includeClaim = true } = {}) {
  if (!row) return null;
  const payload = parseReleaseJson(row.payload_json, `release ${row.batch_id} payload`);
  const result = parseReleaseJson(row.result_json, `release ${row.batch_id} result`);
  const release = {
    batchId: row.batch_id,
    state: row.state,
    releasedAt: row.released_at,
    updatedAt: row.updated_at,
    payload,
    result,
  };
  if (includeClaim) {
    release.claimToken = row.claim_token;
    release.claimExpiresAt = row.claim_expires_at;
  }
  if (!freeze) return release;
  return Object.freeze({
    ...release,
    payload: Object.freeze(payload),
    result: Object.freeze(result),
  });
}

function readOptionalFile(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function controllerSnapshotSet(dbPath) {
  const database = readFileSync(dbPath);
  const wal = readOptionalFile(`${dbPath}-wal`);
  const bytes = database.length + (wal?.length ?? 0);
  if (bytes > MAX_CONTROLLER_SNAPSHOT_BYTES) {
    throw new Error('controller database snapshot exceeds the bounded size');
  }
  return { database, wal };
}

function sameSnapshot(left, right) {
  return left.database.equals(right.database)
    && ((left.wal === null && right.wal === null)
      || (left.wal !== null && right.wal !== null && left.wal.equals(right.wal)));
}

function stableControllerSnapshot(dbPath) {
  for (let attempt = 0; attempt < CONTROLLER_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const first = controllerSnapshotSet(dbPath);
    const second = controllerSnapshotSet(dbPath);
    if (sameSnapshot(first, second)) return second;
  }
  throw new Error('controller database changed during bounded snapshot capture');
}

export class EventControllerReleaseReader {
  constructor(dbPath) {
    if (typeof dbPath !== 'string' || dbPath.length === 0 || dbPath === ':memory:') {
      throw new Error('read-only controller database path is required');
    }
    this.dbPath = realpathSync(dbPath);
    this.snapshotDir = mkdtempSync(join(tmpdir(), 'agent-runner-controller-release-snapshot-'));
    this.db = null;
    try {
      const snapshot = stableControllerSnapshot(this.dbPath);
      const snapshotPath = join(this.snapshotDir, basename(this.dbPath));
      writeFileSync(snapshotPath, snapshot.database, { mode: 0o600 });
      if (snapshot.wal !== null) writeFileSync(`${snapshotPath}-wal`, snapshot.wal, { mode: 0o600 });
      this.db = new DatabaseSync(snapshotPath, { readOnly: true });
      const releaseTable = this.db.prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'event_triage_releases'",
      ).get();
      const schemaTable = this.db.prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'event_controller_schema'",
      ).get();
      if (!releaseTable || !schemaTable) throw new Error('controller database release schema is missing');
      const schema = this.db.prepare('SELECT MAX(version) AS version FROM event_controller_schema').get();
      if (Number(schema?.version) !== EVENT_CONTROLLER_SCHEMA_VERSION) {
        throw new Error(`unsupported controller release schema version: ${String(schema?.version ?? 'missing')}`);
      }
    } catch (error) {
      this.db?.close();
      this.db = null;
      rmSync(this.snapshotDir, { recursive: true, force: true });
      throw error;
    }
  }

  getRelease(batchId) {
    if (typeof batchId !== 'string' || batchId.length === 0) throw new Error('batchId is required');
    return releaseFromRow(this.db.prepare(`
      SELECT * FROM event_triage_releases WHERE batch_id = ?
    `).get(batchId), { freeze: true, includeClaim: false });
  }

  listReleases({ states = ['pending'], limit = 20 } = {}) {
    if (!Array.isArray(states) || states.length === 0 || states.some((state) => !TRIAGE_RELEASE_STATES.includes(state))) {
      throw new Error('triage release states are invalid');
    }
    const boundedLimit = boundedInteger(limit, 20, { min: 1, max: 20, name: 'limit' });
    const placeholders = states.map(() => '?').join(', ');
    return Object.freeze(this.db.prepare(`
      SELECT * FROM event_triage_releases
      WHERE state IN (${placeholders})
      ORDER BY released_at ASC, batch_id ASC
      LIMIT ?
    `).all(...states, boundedLimit).map((row) => releaseFromRow(row, {
      freeze: true,
      includeClaim: false,
    })));
  }

  close() {
    this.db?.close();
    this.db = null;
    rmSync(this.snapshotDir, { recursive: true, force: true });
  }
}

export class EventControllerReleaseStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) throw new Error('event controller db path is required');
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

      CREATE TABLE IF NOT EXISTS event_controller_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_triage_releases (
        batch_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'processed', 'failed')),
        released_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claim_token TEXT,
        claim_expires_at TEXT,
        payload_json TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (batch_id) REFERENCES event_batches(batch_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS event_triage_releases_state_idx
        ON event_triage_releases(state, released_at, batch_id);
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO event_controller_schema(version, applied_at)
      VALUES (?, ?)
    `).run(EVENT_CONTROLLER_SCHEMA_VERSION, this.now());
  }

  listActiveBatchIds({ states = ACTIVE_BATCH_STATES, limit = 100 } = {}) {
    if (!Array.isArray(states) || states.length === 0 || states.some((state) => !ACTIVE_BATCH_STATES.includes(state))) {
      throw new Error('active event batch states are invalid');
    }
    const boundedLimit = boundedInteger(limit, 100, { min: 1, max: 500, name: 'limit' });
    const placeholders = states.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT batch_id FROM event_batches
      WHERE state IN (${placeholders})
      ORDER BY first_event_at ASC, batch_id ASC
      LIMIT ?
    `).all(...states, boundedLimit).map((row) => row.batch_id);
  }

  releaseSettledBatch(batch, { now = this.now() } = {}) {
    if (!batch || batch.state !== 'settled') throw new Error('only a settled batch can be released');
    const timestamp = iso(now);
    const payload = releasePayload(batch);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO event_triage_releases(
        batch_id, state, released_at, updated_at, payload_json, result_json
      ) VALUES (?, 'pending', ?, ?, ?, '{}')
    `).run(batch.batchId, timestamp, timestamp, JSON.stringify(payload));
    return { inserted: Number(result.changes) === 1, release: this.getRelease(batch.batchId) };
  }

  getRelease(batchId) {
    return releaseFromRow(this.db.prepare(`SELECT * FROM event_triage_releases WHERE batch_id = ?`).get(batchId));
  }

  listReleases({ states = ['pending'], limit = 100 } = {}) {
    if (!Array.isArray(states) || states.length === 0 || states.some((state) => !TRIAGE_RELEASE_STATES.includes(state))) {
      throw new Error('triage release states are invalid');
    }
    const boundedLimit = boundedInteger(limit, 100, { min: 1, max: 500, name: 'limit' });
    const placeholders = states.map(() => '?').join(', ');
    return this.db.prepare(`
      SELECT batch_id FROM event_triage_releases
      WHERE state IN (${placeholders})
      ORDER BY released_at ASC, batch_id ASC
      LIMIT ?
    `).all(...states, boundedLimit).map((row) => this.getRelease(row.batch_id));
  }

  claimRelease(batchId, {
    claimToken,
    leaseMs = 5 * 60_000,
    now = this.now(),
  } = {}) {
    if (!CLAIM_TOKEN_PATTERN.test(claimToken || '')) throw new Error('triage claim token is invalid');
    const boundedLeaseMs = boundedInteger(leaseMs, 5 * 60_000, {
      min: 1_000, max: 60 * 60_000, name: 'leaseMs',
    });
    const timestamp = iso(now);
    const expiresAt = new Date(Date.parse(timestamp) + boundedLeaseMs).toISOString();
    const result = this.db.prepare(`
      UPDATE event_triage_releases
      SET state = 'claimed', claim_token = ?, claim_expires_at = ?, updated_at = ?
      WHERE batch_id = ? AND state = 'pending'
    `).run(claimToken, expiresAt, timestamp, batchId);
    return Number(result.changes) === 1 ? this.getRelease(batchId) : null;
  }

  finishRelease(batchId, {
    claimToken,
    state = 'processed',
    result = {},
    now = this.now(),
  } = {}) {
    if (!['processed', 'failed'].includes(state)) throw new Error('triage release final state is invalid');
    if (!CLAIM_TOKEN_PATTERN.test(claimToken || '')) throw new Error('triage claim token is invalid');
    const timestamp = iso(now);
    const updated = this.db.prepare(`
      UPDATE event_triage_releases
      SET state = ?, result_json = ?, claim_token = NULL, claim_expires_at = NULL, updated_at = ?
      WHERE batch_id = ? AND state = 'claimed' AND claim_token = ?
    `).run(state, JSON.stringify(result ?? {}), timestamp, batchId, claimToken);
    return Number(updated.changes) === 1 ? this.getRelease(batchId) : null;
  }

  requeueExpiredClaims({ now = this.now() } = {}) {
    const timestamp = iso(now);
    const result = this.db.prepare(`
      UPDATE event_triage_releases
      SET state = 'pending', claim_token = NULL, claim_expires_at = NULL, updated_at = ?
      WHERE state = 'claimed' AND claim_expires_at <= ?
    `).run(timestamp, timestamp);
    return Number(result.changes);
  }

  close() {
    this.db.close();
  }
}

function projectEnabledForBatch(registry, batch) {
  const project = projectFromRegistryByRepository(registry, batch.repository);
  return Boolean(project && project.projectId === batch.projectId);
}

function shouldRefreshChecks(batch, nowMs, debounceMs, quietPeriodMs, requiredShas) {
  if (requiredShas.length === 0 || batch.state === 'settlement_blocked') return false;
  if (nowMs < Date.parse(batch.lastEventAt) + debounceMs) return false;
  if (batch.state !== 'quiet_period') return true;
  if (!batch.quietStartedAt) return true;
  return nowMs >= Date.parse(batch.quietStartedAt) + quietPeriodMs;
}

export async function runEventControllerCycle({
  registry,
  settlementStore,
  releaseStore,
  githubClient,
  now = new Date().toISOString(),
  debounceMs = 60_000,
  quietPeriodMs = 90_000,
  settlementTimeoutMs = 60 * 60_000,
  batchLimit = 100,
} = {}) {
  if (!registry?.projectsByRepository) throw new Error('project registry is required');
  if (!settlementStore?.attachPendingDeliveries || !settlementStore?.getBatch) {
    throw new Error('settlement store is required');
  }
  if (!releaseStore?.releaseSettledBatch) throw new Error('release store is required');
  if (!githubClient?.requestJson) throw new Error('GitHub read client is required');
  const timestamp = iso(now);
  const nowMs = Date.parse(timestamp);
  const boundedDebounceMs = boundedInteger(debounceMs, 60_000, {
    min: 0, max: 60 * 60_000, name: 'debounceMs',
  });
  const boundedQuietPeriodMs = boundedInteger(quietPeriodMs, 90_000, {
    min: 0, max: 60 * 60_000, name: 'quietPeriodMs',
  });
  const boundedSettlementTimeoutMs = boundedInteger(settlementTimeoutMs, 60 * 60_000, {
    min: 1_000, max: 24 * 60 * 60_000, name: 'settlementTimeoutMs',
  });
  const boundedBatchLimit = boundedInteger(batchLimit, 100, { min: 1, max: 500, name: 'batchLimit' });

  releaseStore.requeueExpiredClaims({ now: timestamp });
  const attachments = settlementStore.attachPendingDeliveries({
    now: timestamp,
    settlementTimeoutMs: boundedSettlementTimeoutMs,
    limit: boundedBatchLimit * 4,
  });
  const batches = releaseStore.listActiveBatchIds({
    states: ACTIVE_BATCH_STATES,
    limit: boundedBatchLimit,
  }).map((batchId) => settlementStore.getBatch(batchId)).filter(Boolean);
  const outcomes = [];
  let released = 0;

  for (const initialBatch of batches) {
    if (!projectEnabledForBatch(registry, initialBatch)) {
      outcomes.push({ batchId: initialBatch.batchId, state: initialBatch.state, reason: 'project-not-enabled' });
      continue;
    }
    try {
      const requiredShas = settlementStore.requiredShas(initialBatch.batchId);
      let providerDiagnostics = [];
      if (shouldRefreshChecks(
        initialBatch,
        nowMs,
        boundedDebounceMs,
        boundedQuietPeriodMs,
        requiredShas,
      )) {
        const refreshed = await refreshBatchGitHubCheckSnapshots({
          settlementStore,
          batchId: initialBatch.batchId,
          client: githubClient,
          observedAt: timestamp,
        });
        providerDiagnostics = refreshed.flatMap((item) => item.diagnostics.map((entry) => ({
          sha: item.sha,
          ...entry,
        })));
      }
      const evaluated = settlementStore.evaluateBatch(initialBatch.batchId, {
        now: timestamp,
        debounceMs: boundedDebounceMs,
        quietPeriodMs: boundedQuietPeriodMs,
      });
      let releaseInserted = false;
      if (evaluated.state === 'settled') {
        releaseInserted = releaseStore.releaseSettledBatch(evaluated, { now: timestamp }).inserted;
        if (releaseInserted) released += 1;
      }
      outcomes.push({
        batchId: evaluated.batchId,
        projectId: evaluated.projectId,
        repository: evaluated.repository,
        state: evaluated.state,
        reason: evaluated.result?.reason ?? null,
        releaseInserted,
        providerDiagnostics,
      });
    } catch (error) {
      outcomes.push({
        batchId: initialBatch.batchId,
        projectId: initialBatch.projectId,
        repository: initialBatch.repository,
        state: initialBatch.state,
        reason: boundedErrorCode(error),
        releaseInserted: false,
        providerDiagnostics: [],
      });
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    observedAt: timestamp,
    deliveriesAttached: attachments.filter((item) => !item.ignored).length,
    deliveriesIgnored: attachments.filter((item) => item.ignored).length,
    batchesInspected: batches.length,
    releasesCreated: released,
    pendingReleases: releaseStore.listReleases({ states: ['pending'], limit: boundedBatchLimit }).length,
    outcomes: Object.freeze(outcomes.map(Object.freeze)),
  });
}
