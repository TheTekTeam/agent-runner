import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  EventControllerReleaseReader,
  EventControllerReleaseStore,
} from './agent-runner-event-controller.mjs';
import { GhCliGitHubReadClient } from './agent-runner-github-checks-provider.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';
import { parsePollingControllerOptions } from './agent-runner-polling-controller-cycle.mjs';
import { runPollingControllerSummaryCommand } from './agent-runner-polling-controller-summary.mjs';
import { collectQueueTriageGitHubEvidence } from './agent-runner-queue-triage-github-evidence.mjs';
import { GhCliGitHubWriteClient } from './agent-runner-queue-triage-github-write.mjs';
import { runQueueTriageReleaseExecutor } from './agent-runner-queue-triage-executor.mjs';

export const QUEUE_TRIAGE_LOCAL_AUTHORITY_SCHEMA_VERSION = 1;
export const QUEUE_TRIAGE_LOCAL_STATE_SCHEMA_VERSION = 1;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_OPEN_ISSUE_ITEMS = 500;
const FALLBACK_RECOVERY_MS = 20 * 60_000;
const MAX_RESULT_BYTES = 64 * 1024;

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
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function boundedInteger(value, fallback, { name, min, max }) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function iso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date.toISOString();
}

function boundedResult(value) {
  const json = stableJson(value);
  if (Buffer.byteLength(json) > MAX_RESULT_BYTES) throw new Error('local queue-triage result exceeds bounded size');
  return JSON.parse(json);
}

function authorityFingerprintInput(authority) {
  return {
    schemaVersion: QUEUE_TRIAGE_LOCAL_AUTHORITY_SCHEMA_VERSION,
    enabled: authority.enabled,
    revision: authority.revision,
    sourceSha: authority.sourceSha.toLowerCase(),
    projectIds: [...authority.projectIds].sort(),
    maxReleasesPerCycle: authority.maxReleasesPerCycle,
  };
}

export function computeQueueTriageLocalAuthorityFingerprint(authority) {
  return sha256(stableJson(authorityFingerprintInput(authority)));
}

export function normalizeQueueTriageLocalAuthority(input) {
  if (!isObject(input)) throw new Error('queue-triage local authority must be an object');
  if (input.schemaVersion !== QUEUE_TRIAGE_LOCAL_AUTHORITY_SCHEMA_VERSION) {
    throw new Error('queue-triage local authority schemaVersion must equal 1');
  }
  if (typeof input.enabled !== 'boolean') throw new Error('queue-triage local authority enabled must be boolean');
  if (typeof input.revision !== 'string' || input.revision.trim().length === 0 || input.revision.length > 255) {
    throw new Error('queue-triage local authority revision is required');
  }
  if (!SHA_PATTERN.test(input.sourceSha ?? '')) throw new Error('queue-triage local authority sourceSha is invalid');
  if (!Array.isArray(input.projectIds) || input.projectIds.length === 0 || input.projectIds.length > 50
    || input.projectIds.some((value) => typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value))) {
    throw new Error('queue-triage local authority projectIds are invalid');
  }
  const projectIds = [...new Set(input.projectIds)].sort();
  if (projectIds.length !== input.projectIds.length) throw new Error('queue-triage local authority projectIds contain duplicates');
  const authority = Object.freeze({
    schemaVersion: QUEUE_TRIAGE_LOCAL_AUTHORITY_SCHEMA_VERSION,
    enabled: input.enabled,
    revision: input.revision,
    sourceSha: input.sourceSha.toLowerCase(),
    projectIds: Object.freeze(projectIds),
    maxReleasesPerCycle: boundedInteger(input.maxReleasesPerCycle, 20, {
      name: 'queue-triage local authority maxReleasesPerCycle', min: 1, max: 20,
    }),
    fingerprint: String(input.fingerprint ?? '').toLowerCase(),
  });
  if (!FINGERPRINT_PATTERN.test(authority.fingerprint)) {
    throw new Error('queue-triage local authority fingerprint is invalid');
  }
  const expected = computeQueueTriageLocalAuthorityFingerprint(authority);
  if (authority.fingerprint !== expected) throw new Error('queue-triage local authority fingerprint mismatch');
  return authority;
}

export function loadQueueTriageLocalAuthority(authorityPath, {
  readFile = readFileSync,
} = {}) {
  if (typeof authorityPath !== 'string' || authorityPath.length === 0) return null;
  const path = resolve(authorityPath);
  let parsed;
  try {
    parsed = JSON.parse(readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error(`invalid queue-triage local authority JSON at ${path}: ${error.message}`);
    throw error;
  }
  return normalizeQueueTriageLocalAuthority(parsed);
}

export class QueueTriageLocalStateStore {
  constructor(path, { now = () => new Date().toISOString() } = {}) {
    if (typeof path !== 'string' || path.length === 0) throw new Error('local queue-triage state path is required');
    this.path = resolve(path);
    this.now = now;
    this.db = new DatabaseSync(this.path);
    this.migrate();
  }

  migrate() {
    const existingSchema = this.db.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'queue_triage_local_schema'
    `).get();
    if (existingSchema) {
      const existing = this.db.prepare('SELECT MAX(version) AS version FROM queue_triage_local_schema').get();
      if (Number(existing?.version) !== QUEUE_TRIAGE_LOCAL_STATE_SCHEMA_VERSION) {
        throw new Error(`unsupported local queue-triage state schema version: ${String(existing?.version ?? 'missing')}`);
      }
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS queue_triage_local_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queue_triage_project_state (
        project_id TEXT PRIMARY KEY,
        last_success_at TEXT,
        last_fallback_id TEXT,
        rotating_cursor INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queue_triage_fallback_runs (
        fallback_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running', 'processed', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        result_json TEXT NOT NULL DEFAULT '{}',
        result_fingerprint TEXT,
        FOREIGN KEY (project_id) REFERENCES queue_triage_project_state(project_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS queue_triage_exception_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        appearances INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES queue_triage_project_state(project_id) ON DELETE RESTRICT
      );
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO queue_triage_local_schema(version, applied_at)
      VALUES (?, ?)
    `).run(QUEUE_TRIAGE_LOCAL_STATE_SCHEMA_VERSION, this.now());
    const schema = this.db.prepare('SELECT MAX(version) AS version FROM queue_triage_local_schema').get();
    if (Number(schema?.version) !== QUEUE_TRIAGE_LOCAL_STATE_SCHEMA_VERSION) {
      throw new Error(`unsupported local queue-triage state schema version: ${String(schema?.version ?? 'missing')}`);
    }
  }

  getProjectState(projectId) {
    const row = this.db.prepare(`
      SELECT project_id, last_success_at, last_fallback_id, rotating_cursor, updated_at
      FROM queue_triage_project_state WHERE project_id = ?
    `).get(projectId);
    if (!row) return Object.freeze({ projectId, lastSuccessAt: null, lastFallbackId: null, rotatingCursor: 0, updatedAt: null });
    return Object.freeze({
      projectId: row.project_id,
      lastSuccessAt: row.last_success_at,
      lastFallbackId: row.last_fallback_id,
      rotatingCursor: Number(row.rotating_cursor),
      updatedAt: row.updated_at,
    });
  }

  ensureProject(projectId, now = this.now()) {
    const timestamp = iso(now, 'project state timestamp');
    this.db.prepare(`
      INSERT OR IGNORE INTO queue_triage_project_state(project_id, updated_at)
      VALUES (?, ?)
    `).run(projectId, timestamp);
  }

  markProjectSuccess(projectId, { now = this.now(), rotatingCursor = 0, fallbackId = null } = {}) {
    const timestamp = iso(now, 'project success timestamp');
    this.ensureProject(projectId, timestamp);
    this.db.prepare(`
      UPDATE queue_triage_project_state
      SET last_success_at = ?, last_fallback_id = COALESCE(?, last_fallback_id),
          rotating_cursor = ?, updated_at = ?
      WHERE project_id = ?
    `).run(timestamp, fallbackId, rotatingCursor, timestamp, projectId);
  }

  beginFallback(fallbackId, projectId, { now = this.now() } = {}) {
    const timestamp = iso(now, 'fallback start timestamp');
    this.ensureProject(projectId, timestamp);
    const existing = this.db.prepare(`
      SELECT state, started_at, result_json, result_fingerprint
      FROM queue_triage_fallback_runs WHERE fallback_id = ?
    `).get(fallbackId);
    if (existing) {
      const staleRunning = existing.state === 'running'
        && Date.parse(timestamp) - Date.parse(existing.started_at) >= FALLBACK_RECOVERY_MS;
      if (staleRunning) {
        this.db.prepare(`
          UPDATE queue_triage_fallback_runs
          SET started_at = ?, completed_at = NULL, result_json = '{}', result_fingerprint = NULL
          WHERE fallback_id = ? AND state = 'running' AND started_at = ?
        `).run(timestamp, fallbackId, existing.started_at);
        return Object.freeze({ inserted: true, recovered: true, state: 'running', result: null, resultFingerprint: null });
      }
      return Object.freeze({
        inserted: false,
        recovered: false,
        state: existing.state,
        result: JSON.parse(existing.result_json),
        resultFingerprint: existing.result_fingerprint,
      });
    }
    this.db.prepare(`
      INSERT INTO queue_triage_fallback_runs(fallback_id, project_id, state, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(fallbackId, projectId, timestamp);
    return Object.freeze({ inserted: true, state: 'running', result: null, resultFingerprint: null });
  }

  finishFallback(fallbackId, state, result, { now = this.now() } = {}) {
    if (!['processed', 'failed'].includes(state)) throw new Error('fallback terminal state is invalid');
    const timestamp = iso(now, 'fallback finish timestamp');
    const bounded = boundedResult(result);
    const json = stableJson(bounded);
    const fingerprint = sha256(json);
    const update = this.db.prepare(`
      UPDATE queue_triage_fallback_runs
      SET state = ?, completed_at = ?, result_json = ?, result_fingerprint = ?
      WHERE fallback_id = ? AND state = 'running'
    `).run(state, timestamp, json, fingerprint, fallbackId);
    if (Number(update.changes) !== 1) throw new Error('fallback run is not owned in running state');
    return Object.freeze({ state, result: bounded, fingerprint });
  }

  recordException(projectId, sourceId, fingerprint, { now = this.now() } = {}) {
    if (!FINGERPRINT_PATTERN.test(fingerprint ?? '')) throw new Error('exception fingerprint is invalid');
    const timestamp = iso(now, 'exception timestamp');
    this.ensureProject(projectId, timestamp);
    this.db.prepare(`
      INSERT INTO queue_triage_exception_fingerprints(
        fingerprint, project_id, source_id, first_seen_at, last_seen_at, appearances
      ) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(fingerprint) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        appearances = queue_triage_exception_fingerprints.appearances + 1
    `).run(fingerprint.toLowerCase(), projectId, sourceId, timestamp, timestamp);
  }

  close() {
    this.db.close();
  }
}

function validateAuthorityProjects(registry, authority) {
  const projects = [];
  for (const projectId of authority.projectIds) {
    const project = registry.projectsById[projectId] ?? null;
    if (!project) throw new Error(`authority project is not enabled in registry: ${projectId}`);
    if (project.queueTriage?.enabled !== true) throw new Error(`queueTriage is not enabled for authority project: ${projectId}`);
    const maxMutations = project.queueTriage.maxMutations;
    if (!Number.isInteger(maxMutations) || maxMutations < 1 || maxMutations > 3) {
      throw new Error(`queueTriage mutation limit is invalid for authority project: ${projectId}`);
    }
    projects.push(project);
  }
  return Object.freeze(projects);
}

export function listAuthorityPendingReleases(reader, projectIds, limit) {
  if (!reader?.db?.prepare || typeof reader.getRelease !== 'function') {
    throw new Error('stable controller release reader is required');
  }
  const boundedLimit = boundedInteger(limit, 20, { name: 'pending release limit', min: 1, max: 20 });
  const ids = [...new Set(projectIds)].sort();
  if (ids.length === 0 || ids.length > 50) throw new Error('authority project IDs are invalid');
  const placeholders = ids.map(() => '?').join(', ');
  const rows = reader.db.prepare(`
    WITH ranked AS (
      SELECT batch_id, released_at,
             json_extract(payload_json, '$.projectId') AS project_id,
             ROW_NUMBER() OVER (
               PARTITION BY json_extract(payload_json, '$.projectId')
               ORDER BY released_at ASC, batch_id ASC
             ) AS project_rank
      FROM event_triage_releases
      WHERE state = 'pending'
        AND json_extract(payload_json, '$.projectId') IN (${placeholders})
    )
    SELECT batch_id FROM ranked
    ORDER BY project_rank ASC, released_at ASC, batch_id ASC
    LIMIT ?
  `).all(...ids, boundedLimit);
  return Object.freeze(rows.map((row) => reader.getRelease(row.batch_id)));
}

function localHourKey(observedAt, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(observedAt));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}`;
}

function listOpenIssues(client, repository) {
  const issues = [];
  let providerItems = 0;
  for (let page = 1; providerItems < MAX_OPEN_ISSUE_ITEMS; page += 1) {
    const payload = client.requestJson(`/repos/${repository}/issues`, {
      state: 'open', sort: 'created', direction: 'asc', per_page: 100, page,
    });
    if (!Array.isArray(payload)) throw new Error('open issue listing is malformed');
    providerItems += payload.length;
    for (const item of payload) {
      if (item?.pull_request || item?.state !== 'open') continue;
      if (!Number.isInteger(item?.number) || item.number < 1) throw new Error('open issue identity is malformed');
      issues.push(item.number);
    }
    if (payload.length < 100) return Object.freeze([...new Set(issues)].sort((a, b) => a - b));
    if (providerItems >= MAX_OPEN_ISSUE_ITEMS) throw new Error('open issue listing exceeds bounded rotation limit');
  }
  return Object.freeze([]);
}

export function selectRotatingIssueNumbers({
  client,
  project,
  observedAt,
  cursor = 0,
  excludedNumbers = [],
} = {}) {
  const all = listOpenIssues(client, project.githubRepo);
  const excluded = new Set(excludedNumbers);
  const issues = all.filter((number) => !excluded.has(number));
  if (issues.length === 0) return Object.freeze({ numbers: Object.freeze([]), nextCursor: cursor, hourKey: localHourKey(observedAt, project.queueTriage.timezone) });
  const hourKey = localHourKey(observedAt, project.queueTriage.timezone);
  let start = issues.findIndex((number) => number > cursor);
  if (start < 0) {
    const seed = Number.parseInt(createHash('sha256').update(`${project.projectId}:${hourKey}`).digest('hex').slice(0, 8), 16);
    start = seed % issues.length;
  }
  const count = Math.min(2, issues.length);
  const selected = [];
  for (let index = 0; index < count; index += 1) selected.push(issues[(start + index) % issues.length]);
  return Object.freeze({ numbers: Object.freeze(selected), nextCursor: selected.at(-1) ?? cursor, hourKey });
}

function syntheticPendingRelease(project, issueNumber, batchId) {
  return Object.freeze({
    batchId,
    state: 'pending',
    releasedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    payload: Object.freeze({
      schemaVersion: 1,
      batchId,
      projectId: project.projectId,
      repository: project.githubRepo,
      objectKind: 'issue',
      objectNumber: issueNumber,
      settledAt: new Date(0).toISOString(),
      deliveryIds: Object.freeze([]),
      shas: Object.freeze([]),
      settlement: Object.freeze({ reason: 'local-rotation', requiredShas: Object.freeze([]), terminalFailures: Object.freeze([]) }),
    }),
    result: Object.freeze({}),
  });
}

function collectRotatingItems({ project, numbers, client, observedAt, collector }) {
  const items = [];
  const diagnostics = [];
  for (const number of numbers) {
    const batchId = `rotation-${sha256(`${project.projectId}:${number}:${observedAt}`).slice(7, 31)}`;
    const evidence = collector({
      release: syntheticPendingRelease(project, number, batchId),
      project,
      client,
      observedAt,
    });
    if (!evidence.liveEvidence?.queryComplete || evidence.changedItems?.length !== 1) {
      diagnostics.push(`rotation-incomplete:${number}`);
      continue;
    }
    items.push(evidence.changedItems[0]);
  }
  return Object.freeze({ items: Object.freeze(items), diagnostics: Object.freeze(diagnostics) });
}

function rotatingCollector({ project, selection, baseCollector = collectQueueTriageGitHubEvidence }) {
  return ({ release, project: liveProject, client, observedAt }) => {
    const base = baseCollector({ release, project: liveProject, client, observedAt });
    const rotation = collectRotatingItems({
      project,
      numbers: selection.numbers,
      client,
      observedAt,
      collector: baseCollector,
    });
    return Object.freeze({
      ...base,
      rotatingItems: rotation.items,
      liveEvidence: Object.freeze({
        ...base.liveEvidence,
        queryComplete: Boolean(base.liveEvidence?.queryComplete) && rotation.diagnostics.length === 0,
        diagnostics: Object.freeze([...(base.liveEvidence?.diagnostics ?? []), ...rotation.diagnostics]),
        rotatingIssueNumbers: selection.numbers,
        rotatingCursor: selection.nextCursor,
      }),
    });
  };
}

function publicExecutionOutcome(result, release, rotation = null) {
  const terminal = result?.terminalResult ?? null;
  const terminalFingerprint = result?.terminalResultFingerprint
    ?? (terminal ? sha256(stableJson(terminal)) : null);
  return Object.freeze({
    batchId: release.batchId,
    projectId: release.payload.projectId,
    repository: release.payload.repository,
    objectKind: release.payload.objectKind,
    objectNumber: release.payload.objectNumber,
    status: result?.status ?? 'unknown',
    mutationsAttempted: result?.runControl?.mutationsAttempted ?? 0,
    mutationsVerified: result?.runControl?.mutationsVerified ?? 0,
    rotatingIssueNumbers: Object.freeze([...(rotation?.numbers ?? [])]),
    terminalResultFingerprint: terminalFingerprint,
    planFingerprint: terminal?.plan?.fingerprint ?? null,
    exceptionCount: terminal?.plan?.exceptionCount ?? 0,
    failureCode: terminal?.failure?.code ?? null,
  });
}

function projectWithMutationBudget(project, remaining) {
  return Object.freeze({
    ...project,
    queueTriage: Object.freeze({ ...project.queueTriage, maxMutations: Math.min(project.queueTriage.maxMutations, remaining) }),
  });
}

function createSyntheticReleaseDatabase(project, issueNumber, fallbackId) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-queue-triage-fallback-'));
  const dbPath = join(directory, 'fallback.sqlite');
  const batchId = `fallback-${sha256(`${fallbackId}:${issueNumber}`).slice(7, 31)}`;
  const bootstrap = new DatabaseSync(dbPath);
  try {
    bootstrap.exec('CREATE TABLE event_batches(batch_id TEXT PRIMARY KEY);');
    bootstrap.prepare('INSERT INTO event_batches(batch_id) VALUES (?)').run(batchId);
  } finally {
    bootstrap.close();
  }
  const store = new EventControllerReleaseStore(dbPath, { now: () => new Date(0).toISOString() });
  try {
    store.releaseSettledBatch({
      batchId,
      state: 'settled',
      projectId: project.projectId,
      repository: project.githubRepo,
      objectKind: 'issue',
      objectNumber: issueNumber,
      settledAt: new Date(0).toISOString(),
      deliveries: [],
      shas: [],
      result: { reason: 'hourly-local-fallback', requiredShas: [], terminalFailures: [] },
    });
  } finally {
    store.close();
  }
  return Object.freeze({ directory, dbPath, batchId });
}

function executeFallbackIssue({
  project,
  issueNumber,
  fallbackId,
  authority,
  observedAt,
  executor,
  readClient,
  writeClient,
} = {}) {
  const fixture = createSyntheticReleaseDatabase(project, issueNumber, fallbackId);
  try {
    const result = executor({
      controllerDb: fixture.dbPath,
      releaseId: fixture.batchId,
      project,
      managerAuthority: { revision: authority.revision, fingerprint: authority.fingerprint },
      readClient,
      writeClient,
      observedAt,
      collectEvidence: collectQueueTriageGitHubEvidence,
    });
    return publicExecutionOutcome(result, syntheticPendingRelease(project, issueNumber, fixture.batchId));
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

function dueForFallback(project, state, observedAt) {
  if (!state.lastSuccessAt) return true;
  const interval = project.queueTriage.fallbackIntervalMinutes * 60_000;
  return Date.parse(observedAt) - Date.parse(state.lastSuccessAt) >= interval;
}

function runControl({ status, sweep, inspected, eligible, processed, failed, writes, verified, fallbackPerformed, fallbackProjects }) {
  return Object.freeze({
    schemaVersion: 1,
    status,
    pendingSweepPerformed: sweep,
    fallbackPerformed,
    fallbackProjects,
    releasesInspected: inspected,
    releasesEligible: eligible,
    releasesProcessed: processed,
    releasesFailed: failed,
    githubWritesPerformed: writes > 0,
    mutationsAttempted: writes,
    mutationsVerified: verified,
    systemdChanged: false,
    scheduledTaskChanged: false,
  });
}

export function runQueueTriageLocalAuthorityCycle({
  controllerDb,
  localStateDb,
  registry,
  authority,
  sourceSha,
  execute = false,
  allEnabled = false,
  forceFallback = false,
  observedAt = new Date().toISOString(),
  readerFactory = (path) => new EventControllerReleaseReader(path),
  releaseSelector = listAuthorityPendingReleases,
  stateStoreFactory = (path) => new QueueTriageLocalStateStore(path),
  executor = runQueueTriageReleaseExecutor,
  readClient = null,
  writeClient = null,
  baseCollector = collectQueueTriageGitHubEvidence,
  rotationSelector = selectRotatingIssueNumbers,
  fallbackExecutor = executeFallbackIssue,
} = {}) {
  if (typeof controllerDb !== 'string' || controllerDb.length === 0) throw new Error('controllerDb is required');
  if (!registry?.projectsById || !Array.isArray(registry.projects)) throw new Error('validated project registry is required');
  const timestamp = iso(observedAt, 'observedAt');
  if (authority == null || authority.enabled !== true) {
    return Object.freeze({
      schemaVersion: 1,
      observedAt: timestamp,
      status: 'disabled',
      authority: null,
      releaseOutcomes: Object.freeze([]),
      fallbackOutcomes: Object.freeze([]),
      runControl: runControl({ status: 'disabled', sweep: false, inspected: 0, eligible: 0, processed: 0, failed: 0, writes: 0, verified: 0, fallbackPerformed: false, fallbackProjects: 0 }),
    });
  }
  if (!SHA_PATTERN.test(sourceSha ?? '') || sourceSha.toLowerCase() !== authority.sourceSha) {
    throw new Error('queue-triage local authority source SHA mismatch');
  }
  const projects = validateAuthorityProjects(registry, authority);
  if (execute === true && allEnabled !== true) {
    throw new Error('--all-enabled is required for local-authority execution');
  }
  if (execute !== true) {
    return Object.freeze({
      schemaVersion: 1,
      observedAt: timestamp,
      status: 'dry-run',
      authority: Object.freeze({ revision: authority.revision, fingerprint: authority.fingerprint }),
      releaseOutcomes: Object.freeze([]),
      fallbackOutcomes: Object.freeze([]),
      runControl: runControl({ status: 'dry-run', sweep: false, inspected: 0, eligible: 0, processed: 0, failed: 0, writes: 0, verified: 0, fallbackPerformed: false, fallbackProjects: 0 }),
    });
  }
  if (typeof localStateDb !== 'string' || localStateDb.length === 0) throw new Error('localStateDb is required for execution');

  const read = readClient ?? new GhCliGitHubReadClient();
  const write = writeClient ?? new GhCliGitHubWriteClient();
  const stateStore = stateStoreFactory(resolve(localStateDb));
  const mutationCounts = new Map(projects.map((project) => [project.projectId, 0]));
  const changedNumbers = new Map(projects.map((project) => [project.projectId, new Set()]));
  const releaseOutcomes = [];
  const fallbackOutcomes = [];
  let releases = [];
  let eligible = 0;
  let processed = 0;
  let failed = 0;
  let writes = 0;
  let verified = 0;
  let fallbackProjects = 0;

  try {
    const reader = readerFactory(resolve(controllerDb));
    try {
      releases = releaseSelector(reader, authority.projectIds, authority.maxReleasesPerCycle);
    } finally {
      reader.close();
    }

    for (const release of releases) {
      const projectId = release?.payload?.projectId;
      const project = registry.projectsById[projectId] ?? null;
      if (!project || String(project.githubRepo).toLowerCase() !== String(release?.payload?.repository).toLowerCase()) {
        throw new Error(`authority release/project identity mismatch: ${release?.batchId ?? 'unknown'}`);
      }
      const used = mutationCounts.get(projectId) ?? 0;
      const remaining = Math.max(0, 3 - used);
      if (remaining === 0) continue;
      eligible += 1;
      const state = stateStore.getProjectState(projectId);
      const excluded = new Set(changedNumbers.get(projectId));
      if (release.payload.objectKind === 'issue') excluded.add(release.payload.objectNumber);
      const selection = rotationSelector({
        client: read,
        project,
        observedAt: timestamp,
        cursor: state.rotatingCursor,
        excludedNumbers: [...excluded],
      });
      const result = executor({
        controllerDb: resolve(controllerDb),
        releaseId: release.batchId,
        project: projectWithMutationBudget(project, remaining),
        managerAuthority: { revision: authority.revision, fingerprint: authority.fingerprint },
        readClient: read,
        writeClient: write,
        observedAt: timestamp,
        collectEvidence: rotatingCollector({ project, selection, baseCollector }),
      });
      const outcome = publicExecutionOutcome(result, release, selection);
      releaseOutcomes.push(outcome);
      writes += outcome.mutationsAttempted;
      verified += outcome.mutationsVerified;
      if (outcome.exceptionCount > 0 && outcome.planFingerprint) {
        stateStore.recordException(projectId, release.batchId, outcome.planFingerprint, { now: timestamp });
      }
      if (outcome.failureCode && outcome.terminalResultFingerprint) {
        stateStore.recordException(projectId, release.batchId, outcome.terminalResultFingerprint, { now: timestamp });
      }
      mutationCounts.set(projectId, used + outcome.mutationsVerified);
      if (release.payload.objectKind === 'issue') changedNumbers.get(projectId).add(release.payload.objectNumber);
      if (outcome.status === 'processed') {
        processed += 1;
        stateStore.markProjectSuccess(projectId, { now: timestamp, rotatingCursor: selection.nextCursor });
        continue;
      }
      if (outcome.status === 'already-terminal') continue;
      failed += 1;
      break;
    }

    if (failed === 0) {
      for (const project of projects) {
        const state = stateStore.getProjectState(project.projectId);
        if (!forceFallback && !dueForFallback(project, state, timestamp)) continue;
        const fallbackId = `fallback:${project.projectId}:${localHourKey(timestamp, project.queueTriage.timezone)}`;
        const started = stateStore.beginFallback(fallbackId, project.projectId, { now: timestamp });
        if (!started.inserted) {
          fallbackOutcomes.push(Object.freeze({
            fallbackId,
            projectId: project.projectId,
            status: `already-${started.state}`,
            issueOutcomes: Object.freeze([]),
          }));
          if (started.state !== 'processed') {
            failed += 1;
            break;
          }
          continue;
        }
        fallbackProjects += 1;
        const selection = rotationSelector({
          client: read,
          project,
          observedAt: timestamp,
          cursor: state.rotatingCursor,
          excludedNumbers: [...changedNumbers.get(project.projectId)],
        });
        const issueOutcomes = [];
        let fallbackFailed = false;
        for (const issueNumber of selection.numbers) {
          const used = mutationCounts.get(project.projectId) ?? 0;
          const remaining = Math.max(0, 3 - used);
          if (remaining === 0) break;
          const outcome = fallbackExecutor({
            project: projectWithMutationBudget(project, remaining),
            issueNumber,
            fallbackId,
            authority,
            observedAt: timestamp,
            executor,
            readClient: read,
            writeClient: write,
          });
          issueOutcomes.push(outcome);
          writes += outcome.mutationsAttempted;
          verified += outcome.mutationsVerified;
          if (outcome.exceptionCount > 0 && outcome.planFingerprint) {
            stateStore.recordException(project.projectId, fallbackId, outcome.planFingerprint, { now: timestamp });
          }
          if (outcome.failureCode && outcome.terminalResultFingerprint) {
            stateStore.recordException(project.projectId, fallbackId, outcome.terminalResultFingerprint, { now: timestamp });
          }
          mutationCounts.set(project.projectId, used + outcome.mutationsVerified);
          if (!['processed', 'already-terminal'].includes(outcome.status)) {
            fallbackFailed = true;
            break;
          }
        }
        const fallbackResult = Object.freeze({
          schemaVersion: 1,
          fallbackId,
          projectId: project.projectId,
          selectedIssueNumbers: selection.numbers,
          issueOutcomes: Object.freeze(issueOutcomes),
          status: fallbackFailed ? 'failed' : 'processed',
        });
        stateStore.finishFallback(fallbackId, fallbackResult.status, fallbackResult, { now: timestamp });
        fallbackOutcomes.push(fallbackResult);
        if (fallbackFailed) {
          failed += 1;
          break;
        }
        stateStore.markProjectSuccess(project.projectId, {
          now: timestamp,
          rotatingCursor: selection.nextCursor,
          fallbackId,
        });
      }
    }
  } finally {
    stateStore.close();
  }

  const status = failed > 0 ? 'failed' : 'completed';
  return Object.freeze({
    schemaVersion: 1,
    observedAt: timestamp,
    status,
    authority: Object.freeze({
      revision: authority.revision,
      fingerprint: authority.fingerprint,
      sourceSha: authority.sourceSha,
      projectIds: authority.projectIds,
    }),
    releaseOutcomes: Object.freeze(releaseOutcomes),
    fallbackOutcomes: Object.freeze(fallbackOutcomes),
    runControl: runControl({
      status,
      sweep: true,
      inspected: releases.length,
      eligible,
      processed,
      failed,
      writes,
      verified,
      fallbackPerformed: fallbackProjects > 0,
      fallbackProjects,
    }),
  });
}

function takeOption(argv, name) {
  const remaining = [];
  let value = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${name} requires a value`);
      value = next;
      index += 1;
    } else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
    else remaining.push(arg);
  }
  return { value, remaining };
}

export function parseClosedLoopOptions(argv = [], env = process.env) {
  const authority = takeOption(argv, '--queue-triage-authority');
  const source = takeOption(authority.remaining, '--queue-triage-source-sha');
  const state = takeOption(source.remaining, '--queue-triage-state-db');
  const execute = state.remaining.includes('--execute');
  const allEnabled = state.remaining.includes('--all-enabled');
  const forceFallback = state.remaining.includes('--fallback');
  if (forceFallback && !allEnabled) throw new Error('--fallback requires --all-enabled');
  const pollingArgv = state.remaining.filter((arg) => !['--execute', '--all-enabled', '--fallback'].includes(arg));
  if (pollingArgv.includes('--pending')) throw new Error('unbounded queue-triage aliases are unavailable');
  return Object.freeze({
    authorityPath: authority.value ?? env.AGENT_RUNNER_QUEUE_TRIAGE_AUTHORITY ?? null,
    sourceSha: source.value ?? env.AGENT_RUNNER_QUEUE_TRIAGE_SOURCE_SHA ?? null,
    localStateDb: state.value ?? env.AGENT_RUNNER_QUEUE_TRIAGE_STATE_DB ?? null,
    execute,
    allEnabled,
    forceFallback,
    pollingArgv: Object.freeze(pollingArgv),
  });
}

export async function runClosedLoopCycle({
  argv = process.argv.slice(2),
  env = process.env,
  observedAt = new Date().toISOString(),
  runPolling = runPollingControllerSummaryCommand,
  parsePolling = parsePollingControllerOptions,
  loadRegistry = loadProjectRegistry,
  loadAuthority = loadQueueTriageLocalAuthority,
  runTriage = runQueueTriageLocalAuthorityCycle,
  readClientFactory = () => new GhCliGitHubReadClient({ env }),
  writeClientFactory = () => new GhCliGitHubWriteClient({ env }),
} = {}) {
  if (argv.includes('--help')) {
    return Object.freeze({
      help: [
        'Usage: node scripts/ops/agent-runner-queue-triage-local-authority.mjs --project-registry <path> [polling options] [--all-enabled [--fallback]] [--execute]',
        '',
        'Optional local-authority inputs:',
        '  --queue-triage-authority <path>',
        '  --queue-triage-source-sha <exact checkout SHA>',
        '  --queue-triage-state-db <path>',
        '  --all-enabled',
        '  --fallback (force a supervised due pass)',
        '',
        'Without a valid enabled authority file the cycle remains read-only after polling/settlement.',
      ].join('\n'),
    });
  }
  const options = parseClosedLoopOptions(argv, env);
  const polling = await runPolling({ argv: options.pollingArgv, env, observedAt });
  const pollingOptions = parsePolling(options.pollingArgv, env);
  const registry = loadRegistry({ registryPath: pollingOptions.registryPath });
  const authority = loadAuthority(options.authorityPath);
  const localStateDb = options.localStateDb ?? join(dirname(pollingOptions.dbPath), 'queue-triage-local.sqlite');
  const triage = runTriage({
    controllerDb: pollingOptions.dbPath,
    localStateDb,
    registry,
    authority,
    sourceSha: options.sourceSha,
    execute: options.execute,
    allEnabled: options.allEnabled,
    forceFallback: options.forceFallback,
    observedAt,
    readClient: readClientFactory(),
    writeClient: writeClientFactory(),
  });
  return Object.freeze({
    schemaVersion: 1,
    observedAt,
    polling,
    triage,
    runControl: Object.freeze({
      schemaVersion: 1,
      pollingCompleted: true,
      fallbackPerformed: triage.runControl.fallbackPerformed,
      queueTriageStatus: triage.status,
      githubWritesPerformed: triage.runControl.githubWritesPerformed,
      mutationsAttempted: triage.runControl.mutationsAttempted,
      mutationsVerified: triage.runControl.mutationsVerified,
      systemdChanged: false,
      scheduledTaskChanged: false,
    }),
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runClosedLoopCycle().then((result) => {
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: typeof error?.code === 'string' ? error.code : 'queue-triage-local-authority-failed',
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
