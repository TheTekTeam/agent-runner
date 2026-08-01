import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  executeLocalExecutorJob,
  LocalExecutorStore,
} from './agent-runner-local-executor.mjs';
import { classifyInterruptedLocalExecutorJobs } from './agent-runner-local-executor-recovery.mjs';
import { projectFromRegistryById } from './agent-runner-project-registry.mjs';

export const LOCAL_EXECUTOR_HANDOFF_SCHEMA_VERSION = 1;
const HANDOFF_STATES = Object.freeze(['pending', 'running', 'succeeded', 'failed']);
const FINAL_HANDOFF_STATES = new Set(['succeeded', 'failed']);
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEFAULT_JOB_TTL_MS = 60 * 60_000;
const DEFAULT_HANDOFF_LEASE_MS = 10 * 60_000;
const MAX_RESULT_BYTES = 16 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function iso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date.toISOString();
}

function boundedInteger(value, fallback, { name, min, max }) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
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

function parseObject(value, name) {
  try {
    const parsed = JSON.parse(value);
    if (!isObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error(`${name} contains invalid JSON object`);
  }
}

function boundedResult(value) {
  const json = stableJson(value);
  if (Buffer.byteLength(json) > MAX_RESULT_BYTES) {
    throw new Error('local executor handoff result exceeds bounded size');
  }
  return json;
}

function finalJobSummary(job) {
  return Object.freeze({
    jobId: job.jobId,
    state: job.state,
    finishedAt: job.finishedAt ?? null,
    errorCode: job.errorCode ?? null,
    resultFingerprint: `sha256:${sha256(stableJson(job.result ?? {}))}`,
  });
}

function handoffFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    batchId: row.batch_id,
    projectId: row.project_id,
    state: row.state,
    job: Object.freeze(parseObject(row.job_json, `handoff ${row.batch_id} job`)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    result: Object.freeze(parseObject(row.result_json, `handoff ${row.batch_id} result`)),
    errorCode: row.error_code,
  });
}

function validateProcessedRelease(row, registry) {
  const payload = parseObject(row.payload_json, `release ${row.batch_id} payload`);
  const result = parseObject(row.result_json, `release ${row.batch_id} result`);
  if (result.kind !== 'queue-triage-execution' || result.state !== 'processed') return null;
  if (result.release?.batchId !== row.batch_id) {
    throw new Error(`release ${row.batch_id} terminal identity mismatch`);
  }
  if (typeof payload.projectId !== 'string' || !payload.projectId) {
    throw new Error(`release ${row.batch_id} project identity is invalid`);
  }
  const project = projectFromRegistryById(registry, payload.projectId);
  if (!project) throw new Error(`release ${row.batch_id} project is not enabled`);
  if (typeof payload.repository !== 'string'
    || payload.repository.toLowerCase() !== project.githubRepo.toLowerCase()) {
    throw new Error(`release ${row.batch_id} repository identity mismatch`);
  }
  return Object.freeze({ payload, result, project });
}

function deterministicJob(row, release, { now, jobTtlMs }) {
  const identity = stableJson({
    schemaVersion: 1,
    batchId: row.batch_id,
    releaseUpdatedAt: row.updated_at,
    projectId: release.payload.projectId,
    releaseResultFingerprint: `sha256:${sha256(stableJson(release.result))}`,
  });
  const digest = sha256(identity);
  return Object.freeze({
    schemaVersion: 1,
    jobId: `triage-inspect-${digest.slice(0, 48)}`,
    nonce: `triage-inspect-nonce-${digest}`,
    projectId: release.payload.projectId,
    operation: 'project.inspect',
    expectedSha: null,
    expiresAt: new Date(Date.parse(now) + jobTtlMs).toISOString(),
    arguments: Object.freeze({}),
  });
}

export class LocalExecutorHandoffStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (typeof dbPath !== 'string' || !dbPath) throw new Error('local executor handoff db path is required');
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

      CREATE TABLE IF NOT EXISTS local_executor_handoff_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_executor_handoff_activation (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        activated_at TEXT NOT NULL,
        cursor_updated_at TEXT,
        cursor_batch_id TEXT
      );

      CREATE TABLE IF NOT EXISTS local_executor_release_handoffs (
        batch_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
        job_id TEXT NOT NULL UNIQUE,
        job_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claim_token TEXT,
        claim_expires_at TEXT,
        result_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT
      );

      CREATE INDEX IF NOT EXISTS local_executor_release_handoffs_state_idx
        ON local_executor_release_handoffs(state, created_at, batch_id);
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO local_executor_handoff_schema(version, applied_at)
      VALUES (?, ?)
    `).run(LOCAL_EXECUTOR_HANDOFF_SCHEMA_VERSION, this.now());
    const schema = this.db.prepare(
      'SELECT MAX(version) AS version FROM local_executor_handoff_schema',
    ).get();
    if (Number(schema?.version) !== LOCAL_EXECUTOR_HANDOFF_SCHEMA_VERSION) {
      throw new Error(`unsupported local executor handoff schema version: ${String(schema?.version ?? 'missing')}`);
    }
  }

  getHandoff(batchId) {
    if (typeof batchId !== 'string' || !batchId) throw new Error('batchId is required');
    return handoffFromRow(this.db.prepare(`
      SELECT * FROM local_executor_release_handoffs WHERE batch_id = ?
    `).get(batchId));
  }

  listHandoffs({ states = ['pending'], limit = 20 } = {}) {
    if (!Array.isArray(states) || states.length === 0
      || states.some((state) => !HANDOFF_STATES.includes(state))) {
      throw new Error('local executor handoff states are invalid');
    }
    const boundedLimit = boundedInteger(limit, 20, {
      name: 'handoff limit', min: 1, max: 100,
    });
    const placeholders = states.map(() => '?').join(', ');
    return Object.freeze(this.db.prepare(`
      SELECT * FROM local_executor_release_handoffs
      WHERE state IN (${placeholders})
      ORDER BY created_at ASC, batch_id ASC
      LIMIT ?
    `).all(...states, boundedLimit).map(handoffFromRow));
  }

  discoverProcessedReleases(registry, {
    now = this.now(),
    limit = 100,
    jobTtlMs = DEFAULT_JOB_TTL_MS,
  } = {}) {
    if (!registry?.projectsById) throw new Error('project registry is required');
    const timestamp = iso(now, 'handoff discovery timestamp');
    const boundedLimit = boundedInteger(limit, 100, {
      name: 'handoff discovery limit', min: 1, max: 500,
    });
    const ttl = boundedInteger(jobTtlMs, DEFAULT_JOB_TTL_MS, {
      name: 'handoff jobTtlMs', min: 60_000, max: 24 * 60 * 60_000,
    });
    const releaseTable = this.db.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'event_triage_releases'
    `).get();
    if (!releaseTable) throw new Error('controller triage release table is missing');

    const activation = this.db.prepare(`
      SELECT activated_at, cursor_updated_at, cursor_batch_id
      FROM local_executor_handoff_activation WHERE singleton_id = 1
    `).get();

    if (!activation) {
      const latest = this.db.prepare(`
        SELECT updated_at, batch_id
        FROM event_triage_releases
        WHERE state = 'processed'
        ORDER BY updated_at DESC, batch_id DESC
        LIMIT 1
      `).get();
      this.db.prepare(`
        INSERT INTO local_executor_handoff_activation(
          singleton_id, activated_at, cursor_updated_at, cursor_batch_id
        ) VALUES (1, ?, ?, ?)
      `).run(
        timestamp,
        latest?.updated_at ?? null,
        latest?.batch_id ?? null,
      );
      return Object.freeze([]);
    }

    const rows = activation.cursor_updated_at === null
      ? this.db.prepare(`
          SELECT releases.batch_id, releases.updated_at,
                 releases.payload_json, releases.result_json
          FROM event_triage_releases AS releases
          LEFT JOIN local_executor_release_handoffs AS handoffs
            ON handoffs.batch_id = releases.batch_id
          WHERE releases.state = 'processed'
            AND handoffs.batch_id IS NULL
          ORDER BY releases.updated_at ASC, releases.batch_id ASC
          LIMIT ?
        `).all(boundedLimit)
      : this.db.prepare(`
          SELECT releases.batch_id, releases.updated_at,
                 releases.payload_json, releases.result_json
          FROM event_triage_releases AS releases
          LEFT JOIN local_executor_release_handoffs AS handoffs
            ON handoffs.batch_id = releases.batch_id
          WHERE releases.state = 'processed'
            AND handoffs.batch_id IS NULL
            AND (
              releases.updated_at > ?
              OR (releases.updated_at = ? AND releases.batch_id > ?)
            )
          ORDER BY releases.updated_at ASC, releases.batch_id ASC
          LIMIT ?
        `).all(
          activation.cursor_updated_at,
          activation.cursor_updated_at,
          activation.cursor_batch_id,
          boundedLimit,
        );

    const inserted = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.db.prepare(`
        INSERT OR IGNORE INTO local_executor_release_handoffs(
          batch_id, project_id, state, job_id, job_json, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?)
      `);
      for (const row of rows) {
        const release = validateProcessedRelease(row, registry);
        if (!release) continue;
        const job = deterministicJob(row, release, { now: timestamp, jobTtlMs: ttl });
        const result = statement.run(
          row.batch_id,
          release.payload.projectId,
          job.jobId,
          stableJson(job),
          timestamp,
          timestamp,
        );
        if (Number(result.changes) === 1) inserted.push(this.getHandoff(row.batch_id));
      }
      const last = rows.at(-1);
      if (last) {
        this.db.prepare(`
          UPDATE local_executor_handoff_activation
          SET cursor_updated_at = ?, cursor_batch_id = ?
          WHERE singleton_id = 1
        `).run(last.updated_at, last.batch_id);
      }
      this.db.exec('COMMIT');
      return Object.freeze(inserted);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimHandoff(batchId, {
    claimToken = `executor-handoff-${randomUUID()}`,
    leaseMs = DEFAULT_HANDOFF_LEASE_MS,
    now = this.now(),
  } = {}) {
    if (!TOKEN_PATTERN.test(claimToken)) throw new Error('local executor handoff claim token is invalid');
    const timestamp = iso(now, 'handoff claim timestamp');
    const lease = boundedInteger(leaseMs, DEFAULT_HANDOFF_LEASE_MS, {
      name: 'handoff leaseMs', min: 1_000, max: 60 * 60_000,
    });
    const expiresAt = new Date(Date.parse(timestamp) + lease).toISOString();
    const result = this.db.prepare(`
      UPDATE local_executor_release_handoffs
      SET state = 'running', claim_token = ?, claim_expires_at = ?, updated_at = ?
      WHERE batch_id = ? AND state = 'pending'
    `).run(claimToken, expiresAt, timestamp, batchId);
    return Number(result.changes) === 1 ? this.getHandoff(batchId) : null;
  }

  finishHandoff(batchId, {
    claimToken,
    state,
    result = {},
    errorCode = null,
    now = this.now(),
  } = {}) {
    if (!TOKEN_PATTERN.test(claimToken || '')) throw new Error('local executor handoff claim token is invalid');
    if (!FINAL_HANDOFF_STATES.has(state)) throw new Error('local executor handoff final state is invalid');
    const timestamp = iso(now, 'handoff finish timestamp');
    const updated = this.db.prepare(`
      UPDATE local_executor_release_handoffs
      SET state = ?, result_json = ?, error_code = ?,
          claim_token = NULL, claim_expires_at = NULL, updated_at = ?
      WHERE batch_id = ? AND state = 'running' AND claim_token = ?
    `).run(state, boundedResult(result), errorCode, timestamp, batchId, claimToken);
    return Number(updated.changes) === 1 ? this.getHandoff(batchId) : null;
  }

  reconcileExpiredClaims(localExecutorStore, { now = this.now() } = {}) {
    if (!localExecutorStore?.getJob) throw new Error('local executor store is required');
    const timestamp = iso(now, 'handoff reconciliation timestamp');
    const rows = this.db.prepare(`
      SELECT batch_id, project_id, job_id, claim_token
      FROM local_executor_release_handoffs
      WHERE state = 'running' AND claim_expires_at <= ?
      ORDER BY updated_at ASC, batch_id ASC
      LIMIT 100
    `).all(timestamp);
    const reconciled = [];

    for (const row of rows) {
      const job = localExecutorStore.getJob(row.job_id);
      if (job && FINAL_HANDOFF_STATES.has(job.state)) {
        const handoff = this.finishHandoff(row.batch_id, {
          claimToken: row.claim_token,
          state: job.state,
          result: { job: finalJobSummary(job), recoveredAfterRestart: true },
          errorCode: job.errorCode,
          now: timestamp,
        });
        if (handoff) reconciled.push(handoff);
        continue;
      }

      if (job?.state === 'running') {
        const lock = localExecutorStore.db.prepare(`
          SELECT expires_at FROM local_executor_project_locks
          WHERE project_id = ? AND job_id = ?
        `).get(row.project_id, row.job_id);
        if (lock && lock.expires_at > timestamp) {
          this.db.prepare(`
            UPDATE local_executor_release_handoffs
            SET claim_expires_at = ?, updated_at = ?
            WHERE batch_id = ? AND state = 'running' AND claim_token = ?
          `).run(lock.expires_at, timestamp, row.batch_id, row.claim_token);
          continue;
        }
      }

      const result = this.db.prepare(`
        UPDATE local_executor_release_handoffs
        SET state = 'pending', claim_token = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE batch_id = ? AND state = 'running' AND claim_token = ?
      `).run(timestamp, row.batch_id, row.claim_token);
      if (Number(result.changes) === 1) reconciled.push(this.getHandoff(row.batch_id));
    }
    return Object.freeze(reconciled);
  }

  close() {
    this.db.close();
  }
}

function boundedFailureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : 'handoff-execution-failed';
  return /^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(code) ? code : 'handoff-execution-failed';
}

export function runLocalExecutorHandoffCycle({
  controllerDb,
  registry,
  policy,
  now = new Date().toISOString(),
  discoveryLimit = 100,
  executionLimit = 20,
  jobTtlMs = DEFAULT_JOB_TTL_MS,
  leaseMs = DEFAULT_HANDOFF_LEASE_MS,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  spawn,
  env = process.env,
  storeFactory = (path) => new LocalExecutorHandoffStore(path),
  localStoreFactory = (path) => new LocalExecutorStore(path),
  execute = executeLocalExecutorJob,
  recover = classifyInterruptedLocalExecutorJobs,
} = {}) {
  if (typeof controllerDb !== 'string' || !controllerDb) throw new Error('controllerDb is required');
  if (!registry?.projectsById) throw new Error('project registry is required');
  if (!policy?.projectsById) throw new Error('local executor policy is required');
  if (uid === 0) throw new Error('local executor handoff must not run as root');
  const timestamp = iso(now, 'handoff cycle timestamp');
  const boundedExecutionLimit = boundedInteger(executionLimit, 20, {
    name: 'handoff executionLimit', min: 1, max: 20,
  });
  const store = storeFactory(controllerDb);
  const localStore = localStoreFactory(controllerDb);
  const outcomes = [];
  try {
    const recoveredJobs = recover(localStore, { now: timestamp });
    const reconciled = store.reconcileExpiredClaims(localStore, { now: timestamp });
    const discovered = store.discoverProcessedReleases(registry, {
      now: timestamp,
      limit: discoveryLimit,
      jobTtlMs,
    });
    const pending = store.listHandoffs({ states: ['pending'], limit: boundedExecutionLimit });

    for (const handoff of pending) {
      const claimToken = `executor-handoff-${randomUUID()}`;
      const claimed = store.claimHandoff(handoff.batchId, {
        claimToken,
        leaseMs,
        now: timestamp,
      });
      if (!claimed) continue;
      try {
        const execution = execute({
          input: claimed.job,
          registry,
          policy,
          store: localStore,
          uid,
          ...(spawn ? { spawn } : {}),
          env,
          now: timestamp,
        });
        const finalJob = execution?.job;
        if (!finalJob || !FINAL_HANDOFF_STATES.has(finalJob.state)) {
          throw new Error('local executor did not return a final job');
        }
        const finished = store.finishHandoff(claimed.batchId, {
          claimToken,
          state: finalJob.state,
          result: {
            job: finalJobSummary(finalJob),
            replay: execution.replay === true,
          },
          errorCode: finalJob.errorCode,
          now: timestamp,
        });
        outcomes.push(Object.freeze({
          batchId: claimed.batchId,
          state: finished?.state ?? finalJob.state,
          jobId: finalJob.jobId,
          replay: execution.replay === true,
        }));
      } catch (error) {
        const code = boundedFailureCode(error);
        const finished = store.finishHandoff(claimed.batchId, {
          claimToken,
          state: 'failed',
          result: {
            refusedBeforeFinalJob: true,
            errorCode: code,
          },
          errorCode: code,
          now: timestamp,
        });
        outcomes.push(Object.freeze({
          batchId: claimed.batchId,
          state: finished?.state ?? 'failed',
          jobId: claimed.job.jobId,
          replay: false,
        }));
      }
    }

    return Object.freeze({
      schemaVersion: 1,
      recoveredJobs: recoveredJobs.length,
      reconciledHandoffs: reconciled.length,
      discoveredHandoffs: discovered.length,
      executedHandoffs: outcomes.length,
      outcomes: Object.freeze(outcomes),
    });
  } finally {
    localStore.close();
    store.close();
  }
}
