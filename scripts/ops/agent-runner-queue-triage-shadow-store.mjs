import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  evidenceFingerprint,
  planQueueTriageRun,
  stableJson,
} from './agent-runner-queue-triage.mjs';

export const QUEUE_TRIAGE_SHADOW_SCHEMA_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_STORED_JSON_BYTES = 512 * 1024;

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid timestamp: ${String(value)}`);
  return date.toISOString();
}

function boundedJson(value, name) {
  const json = stableJson(value);
  if (Buffer.byteLength(json) > MAX_STORED_JSON_BYTES) {
    throw new Error(`${name} exceeds the bounded size`);
  }
  return json;
}

function boundedString(value, name, maxLength = 255, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeShadowRelease(release) {
  if (!release || !ID_PATTERN.test(release.batchId || '')) throw new Error('release batchId is invalid');
  if (release.state !== 'pending') throw new Error('only pending releases may be shadow-observed');
  const payload = release.payload;
  boundedJson(payload, 'controller release payload');
  if (!payload || payload.schemaVersion !== 1 || payload.batchId !== release.batchId
    || !ID_PATTERN.test(payload.projectId || '')) {
    throw new Error('release payload identity is invalid');
  }
  const repository = boundedString(payload.repository, 'release payload repository');
  if (!repository.includes('/')) throw new Error('release payload identity is invalid');
  if (!['issue', 'pull_request', 'repository'].includes(payload.objectKind)) {
    throw new Error('release payload objectKind is invalid');
  }
  if (payload.objectKind === 'repository') {
    if (payload.objectNumber != null) throw new Error('release payload objectNumber is invalid');
  } else if (!Number.isInteger(payload.objectNumber) || payload.objectNumber < 1) {
    throw new Error('release payload objectNumber is invalid');
  }
  if (!Array.isArray(payload.deliveryIds) || payload.deliveryIds.length > 1_000) {
    throw new Error('release payload deliveryIds are invalid');
  }
  if (!Array.isArray(payload.shas) || payload.shas.length > 100) {
    throw new Error('release payload shas are invalid');
  }
  const settlementReason = payload.settlement?.reason == null
    ? null
    : boundedString(payload.settlement.reason, 'release settlement reason', 64, { nullable: true });

  return Object.freeze({
    batchId: release.batchId,
    state: release.state,
    releasedAt: iso(release.releasedAt),
    updatedAt: iso(release.updatedAt),
    projectId: payload.projectId,
    repository,
    objectKind: payload.objectKind,
    objectNumber: payload.objectNumber ?? null,
    settledAt: payload.settledAt ? iso(payload.settledAt) : null,
    settlementReason,
    payloadFingerprint: evidenceFingerprint(payload),
    deliveryFingerprint: evidenceFingerprint(payload.deliveryIds),
    shaFingerprint: evidenceFingerprint(payload.shas),
    settlementFingerprint: evidenceFingerprint(payload.settlement ?? {}),
  });
}

export function validateShadowEvidenceIdentity(release, evidence) {
  if (!evidence || evidence.mode !== 'release' || evidence.releaseId !== release.batchId) {
    throw new Error('normalized evidence release identity does not match the observed release');
  }
  if (evidence.project?.projectId !== release.projectId
    || String(evidence.project?.repository || '').toLowerCase() !== release.repository.toLowerCase()) {
    throw new Error('normalized evidence project identity does not match the observed release');
  }
  if (release.objectKind !== 'repository') {
    const matches = (evidence.changedItems ?? []).filter((item) => (
      item.kind === release.objectKind
      && item.number === release.objectNumber
      && String(item.repository || '').toLowerCase() === release.repository.toLowerCase()
    ));
    if (matches.length !== 1) {
      throw new Error('normalized evidence object identity does not match the observed release');
    }
  }
}

export class QueueTriageShadowStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) throw new Error('shadow database path is required');
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

      CREATE TABLE IF NOT EXISTS queue_triage_shadow_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queue_triage_shadow_observations (
        batch_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        object_kind TEXT NOT NULL,
        object_number INTEGER,
        released_at TEXT NOT NULL,
        controller_updated_at TEXT NOT NULL,
        settled_at TEXT,
        settlement_reason TEXT,
        payload_fingerprint TEXT NOT NULL,
        delivery_fingerprint TEXT NOT NULL,
        sha_fingerprint TEXT NOT NULL,
        settlement_fingerprint TEXT NOT NULL,
        first_observed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queue_triage_shadow_reports (
        report_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        report_fingerprint TEXT NOT NULL,
        planned_at TEXT NOT NULL,
        report_json TEXT NOT NULL,
        FOREIGN KEY (batch_id) REFERENCES queue_triage_shadow_observations(batch_id) ON DELETE RESTRICT,
        UNIQUE (batch_id, evidence_fingerprint)
      );
    `);
    this.db.prepare(`
      INSERT OR IGNORE INTO queue_triage_shadow_schema(version, applied_at)
      VALUES (?, ?)
    `).run(QUEUE_TRIAGE_SHADOW_SCHEMA_VERSION, iso(this.now()));
  }

  getObservation(batchId) {
    const row = this.db.prepare(`
      SELECT * FROM queue_triage_shadow_observations WHERE batch_id = ?
    `).get(batchId);
    if (!row) return null;
    return Object.freeze({
      batchId: row.batch_id,
      projectId: row.project_id,
      repository: row.repository,
      objectKind: row.object_kind,
      objectNumber: row.object_number,
      releasedAt: row.released_at,
      controllerUpdatedAt: row.controller_updated_at,
      settledAt: row.settled_at,
      settlementReason: row.settlement_reason,
      payloadFingerprint: row.payload_fingerprint,
      firstObservedAt: row.first_observed_at,
    });
  }

  observeRelease(release, { observedAt = this.now() } = {}) {
    const normalized = normalizeShadowRelease(release);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO queue_triage_shadow_observations(
        batch_id,
        project_id,
        repository,
        object_kind,
        object_number,
        released_at,
        controller_updated_at,
        settled_at,
        settlement_reason,
        payload_fingerprint,
        delivery_fingerprint,
        sha_fingerprint,
        settlement_fingerprint,
        first_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.batchId,
      normalized.projectId,
      normalized.repository,
      normalized.objectKind,
      normalized.objectNumber,
      normalized.releasedAt,
      normalized.updatedAt,
      normalized.settledAt,
      normalized.settlementReason,
      normalized.payloadFingerprint,
      normalized.deliveryFingerprint,
      normalized.shaFingerprint,
      normalized.settlementFingerprint,
      iso(observedAt),
    );
    const observation = this.getObservation(normalized.batchId);
    if (!observation
      || observation.payloadFingerprint !== normalized.payloadFingerprint
      || observation.projectId !== normalized.projectId
      || observation.repository.toLowerCase() !== normalized.repository.toLowerCase()) {
      throw codedError(
        'shadow-release-collision',
        `release ${normalized.batchId} changed after shadow observation`,
      );
    }
    const inserted = Number(insert.changes) === 1;
    return Object.freeze({ inserted, replayed: !inserted, observation });
  }

  attachEvidenceAndPlan(release, evidence, { plannedAt = this.now() } = {}) {
    const observation = this.observeRelease(release, { observedAt: plannedAt }).observation;
    const normalized = normalizeShadowRelease(release);
    validateShadowEvidenceIdentity(normalized, evidence);
    const evidenceJson = boundedJson(evidence, 'normalized evidence');
    const evidenceFingerprintValue = evidenceFingerprint(JSON.parse(evidenceJson));
    const report = planQueueTriageRun(evidence);
    const reportJson = boundedJson(report, 'dry-run report');
    const reportFingerprint = evidenceFingerprint(JSON.parse(reportJson));
    const reportId = `shadow-report-${evidenceFingerprint({
      batchId: normalized.batchId,
      evidenceFingerprint: evidenceFingerprintValue,
    }).slice(7, 31)}`;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO queue_triage_shadow_reports(
        report_id,
        batch_id,
        evidence_fingerprint,
        report_fingerprint,
        planned_at,
        report_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      reportId,
      normalized.batchId,
      evidenceFingerprintValue,
      reportFingerprint,
      iso(plannedAt),
      reportJson,
    );
    const row = this.db.prepare(`
      SELECT * FROM queue_triage_shadow_reports
      WHERE batch_id = ? AND evidence_fingerprint = ?
    `).get(normalized.batchId, evidenceFingerprintValue);
    if (!row || row.report_fingerprint !== reportFingerprint) {
      throw codedError(
        'shadow-report-collision',
        `release ${normalized.batchId} produced a changed report for identical evidence`,
      );
    }
    const inserted = Number(insert.changes) === 1;
    return Object.freeze({
      inserted,
      replayed: !inserted,
      observation,
      report: Object.freeze(JSON.parse(row.report_json)),
      reportId: row.report_id,
    });
  }

  counts() {
    return Object.freeze({
      observations: Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM queue_triage_shadow_observations
      `).get().count),
      reports: Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM queue_triage_shadow_reports
      `).get().count),
    });
  }

  close() {
    this.db.close();
  }
}
