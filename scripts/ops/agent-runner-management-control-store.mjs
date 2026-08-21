#!/usr/bin/env node

/**
 * #268: bounded control-plane persistence for the event-driven management
 * graph.
 *
 * This is deliberately **not** a second state store. It adds a small set of
 * additive tables to the same controller SQLite database the #289 management
 * event ledger already uses, and it stores nothing the ledger already owns:
 * event identity, claims, leases, delays and successors remain #289's.
 *
 * What lives here is the bounded *result* of management work:
 *
 *  - the current control mode plus an append-only audit of every mode change;
 *  - the single mutating-manager lock (with lease recovery);
 *  - one bounded decision record per settled management event;
 *  - bounded read-only assurance findings;
 *  - the deduplicated per-project status projection;
 *  - bounded operational observations for the dashboard/operator.
 *
 * Every string that reaches a column is positively allowlisted first. Prompts,
 * provider output, transcripts, raw comments, logs, credentials, environment
 * values, command lines and machine-local paths can never be written here:
 * there is no column that accepts free-form text without the bounded-safe-text
 * scan, and the payload column only ever receives an already-validated
 * projection.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  MANAGEMENT_CONTROL_MODES,
  MANAGEMENT_ROLES,
} from './agent-runner-management-control-mode.mjs';
import {
  assertBoundedSafeText,
  isPlainObject,
  nonEmptyString,
  stableJson,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_CONTROL_STORE_SCHEMA_VERSION = 1;

/** The bounded signals the control plane records for operators and the dashboard. */
export const MANAGEMENT_OBSERVATION_SIGNALS = Object.freeze([
  'event-enqueued',
  'event-coalesced',
  'event-duplicate',
  'event-claimed',
  'handler-started',
  'handler-outcome',
  'handler-refused',
  'handler-failed',
  'successors-created',
  'retry-scheduled',
  'event-dead-lettered',
  'assurance-finding',
  'projection-revised',
  'projection-unchanged',
  'control-mode-resolved',
  'manager-lock-acquired',
  'manager-lock-refused',
  'manager-lock-released',
]);

/** Bounded assurance severities. */
export const MANAGEMENT_FINDING_SEVERITIES = Object.freeze(['informational', 'correctable', 'owner-attention', 'blocking']);

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_LEASE_MS = 5 * 60_000;
const MAX_OBSERVATIONS = 500;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

const SIGNAL_SET = new Set(MANAGEMENT_OBSERVATION_SIGNALS);
const SEVERITY_SET = new Set(MANAGEMENT_FINDING_SEVERITIES);
const MODE_SET = new Set(MANAGEMENT_CONTROL_MODES);
const ROLE_SET = new Set(MANAGEMENT_ROLES);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredId(value, name) {
  if (!nonEmptyString(value) || !ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredToken(value, name) {
  if (!nonEmptyString(value) || !TOKEN_PATTERN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredRepository(value) {
  if (!nonEmptyString(value) || !REPOSITORY_PATTERN.test(value)) {
    throw new Error('management control repository is invalid');
  }
  return value;
}

function optionalPositiveInteger(value, name) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`${name} must be a bounded positive integer`);
  return value;
}

function optionalSha(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || !SHA_PATTERN.test(value.toLowerCase())) throw new Error(`${name} must be an exact 40-character commit SHA`);
  return value.toLowerCase();
}

function requiredFingerprint(value, name) {
  if (!nonEmptyString(value) || !FINGERPRINT_PATTERN.test(value)) throw new Error(`${name} must be a sha256 content fingerprint`);
  return value;
}

function iso(value, name) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${name} is invalid`);
    return value.toISOString();
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) throw new Error(`${name} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed.toISOString();
}

/**
 * The only way a human-readable reason reaches a column. It is bounded and
 * scanned for local paths, secrets, shell payloads and raw prompt/log content,
 * so an operator-supplied reason can never smuggle unsafe material into
 * control-plane state.
 */
function safeReason(value, name, { max = 200 } = {}) {
  const errors = [];
  assertBoundedSafeText(value, name, errors, { max, allowWriteActionScan: false });
  if (errors.length) throw new Error(`Refusing management control write: ${errors.join('; ')}`);
  return value.trim();
}

const MIGRATIONS = Object.freeze({
  1: `
      CREATE TABLE IF NOT EXISTS management_control_mode_state (
        scope TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('disabled', 'shadow', 'active', 'fenced')),
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS management_control_mode_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        previous_mode TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('disabled', 'shadow', 'active', 'fenced')),
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS management_control_locks (
        scope TEXT PRIMARY KEY,
        holder_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS management_control_decisions (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        role TEXT NOT NULL,
        event_type TEXT NOT NULL,
        control_mode TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        mutation_suppressed INTEGER NOT NULL CHECK (mutation_suppressed IN (0, 1)),
        issue_number INTEGER,
        pull_request_number INTEGER,
        exact_sha TEXT,
        correlation_id TEXT NOT NULL,
        successor_count INTEGER NOT NULL CHECK (successor_count >= 0),
        decision_fingerprint TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS management_control_decisions_project_idx
        ON management_control_decisions(project_id, recorded_at, event_id);

      CREATE TABLE IF NOT EXISTS management_control_findings (
        finding_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        finding_class TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('informational', 'correctable', 'owner-attention', 'blocking')),
        issue_number INTEGER,
        pull_request_number INTEGER,
        exact_sha TEXT,
        correlation_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS management_control_findings_project_idx
        ON management_control_findings(project_id, recorded_at, finding_id);

      CREATE TABLE IF NOT EXISTS management_control_projections (
        project_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS management_control_observations (
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal TEXT NOT NULL,
        project_id TEXT,
        repo TEXT,
        event_id TEXT,
        event_type TEXT,
        role TEXT,
        control_mode TEXT,
        detail TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS management_control_observations_recent_idx
        ON management_control_observations(recorded_at, observation_id);
  `,
});

/**
 * Bounded control-plane persistence. Opens its own connection to the shared
 * controller database, exactly as the existing ingress/settlement/event stores
 * do, and relies on WAL plus an explicit busy timeout to serialise with them.
 */
export class ManagementControlStore {
  constructor(dbPath, { now = () => new Date().toISOString(), busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
    if (!nonEmptyString(dbPath)) throw new Error('management control store db path is required');
    this.dbPath = dbPath;
    this.now = now;
    this.busyTimeoutMs = Number.isInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 60_000
      ? busyTimeoutMs
      : DEFAULT_BUSY_TIMEOUT_MS;
    this.transactionActive = false;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  runInTransaction(work) {
    if (this.transactionActive) throw new Error('management control transaction is already active');
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionActive = true;
    let result;
    try {
      result = work();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original failure below is the one the caller must see.
      }
      this.transactionActive = false;
      throw error;
    }
    this.transactionActive = false;
    return result;
  }

  migrate() {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS management_control_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const recorded = this.db.prepare('SELECT MAX(version) AS version FROM management_control_schema').get();
    const applied = recorded?.version == null ? 0 : Number(recorded.version);
    if (!Number.isInteger(applied) || applied < 0) {
      throw new Error(`unsupported management control schema version: ${String(recorded?.version)}`);
    }
    // Fail closed against a database written by newer code before writing to it.
    if (applied > MANAGEMENT_CONTROL_STORE_SCHEMA_VERSION) {
      throw new Error(`unsupported management control schema version: ${applied}`);
    }
    if (applied === MANAGEMENT_CONTROL_STORE_SCHEMA_VERSION) return;
    const appliedAt = iso(this.now(), 'management control migration timestamp');
    this.runInTransaction(() => {
      for (let version = applied + 1; version <= MANAGEMENT_CONTROL_STORE_SCHEMA_VERSION; version += 1) {
        const migration = MIGRATIONS[version];
        if (typeof migration !== 'string') throw new Error(`missing management control migration for version ${version}`);
        this.db.exec(migration);
        this.db.prepare('INSERT OR IGNORE INTO management_control_schema(version, applied_at) VALUES (?, ?)').run(version, appliedAt);
      }
    });
  }

  // ---------------------------------------------------------------- control mode

  /**
   * The persisted mode for one control scope.
   *
   * An unset scope reports `disabled`, so a restart of a control plane that was
   * never explicitly enabled can never come back mutating. A row carrying a
   * value this build does not recognise reports `null`, which every caller
   * treats as an unknown mode and refuses -- a downgrade can therefore never
   * reinterpret a newer mode as a permissive one.
   */
  getControlMode(scope = 'global') {
    const scopeId = requiredId(scope, 'management control scope');
    const row = this.db.prepare('SELECT * FROM management_control_mode_state WHERE scope = ?').get(scopeId);
    if (!row) {
      return Object.freeze({ scope: scopeId, mode: 'disabled', reason: 'never-configured', actor: null, updatedAt: null, configured: false });
    }
    const mode = MODE_SET.has(row.mode) ? row.mode : null;
    return Object.freeze({
      scope: scopeId,
      mode,
      reason: row.reason,
      actor: row.actor,
      updatedAt: row.updated_at,
      configured: true,
    });
  }

  /**
   * Change the mode for one scope. Every change is explicit, attributed and
   * appended to the audit trail; there is no implicit or inferred transition,
   * and in particular nothing here can re-enable an external scheduled task.
   */
  setControlMode({ scope = 'global', mode, reason, actor, now = this.now() } = {}) {
    const scopeId = requiredId(scope, 'management control scope');
    if (!nonEmptyString(mode) || !MODE_SET.has(mode)) throw new Error(`unknown management control mode: ${String(mode ?? '')}`);
    const safeActor = requiredId(actor, 'management control mode actor');
    const safeText = safeReason(reason, 'management control mode reason');
    const timestamp = iso(now, 'management control mode timestamp');
    return this.runInTransaction(() => {
      const previous = this.db.prepare('SELECT mode FROM management_control_mode_state WHERE scope = ?').get(scopeId);
      const previousMode = previous?.mode ?? null;
      this.db.prepare(`
        INSERT INTO management_control_mode_state(scope, mode, reason, actor, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET mode = excluded.mode, reason = excluded.reason,
          actor = excluded.actor, updated_at = excluded.updated_at
      `).run(scopeId, mode, safeText, safeActor, timestamp);
      this.db.prepare(`
        INSERT INTO management_control_mode_audit(scope, previous_mode, mode, reason, actor, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(scopeId, previousMode, mode, safeText, safeActor, timestamp);
      return Object.freeze({ scope: scopeId, previousMode, mode, reason: safeText, actor: safeActor, updatedAt: timestamp });
    });
  }

  listControlModeAudit({ scope = 'global', limit = 50 } = {}) {
    const scopeId = requiredId(scope, 'management control scope');
    const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 50;
    return Object.freeze(this.db.prepare(`
      SELECT * FROM management_control_mode_audit WHERE scope = ?
      ORDER BY audit_id DESC LIMIT ?
    `).all(scopeId, bounded).map((row) => Object.freeze({
      auditId: Number(row.audit_id),
      scope: row.scope,
      previousMode: row.previous_mode,
      mode: row.mode,
      reason: row.reason,
      actor: row.actor,
      recordedAt: row.recorded_at,
    })));
  }

  // ---------------------------------------------------------------- manager lock

  /**
   * Acquire the single mutating-manager lock for one control scope.
   *
   * The holder is stored only as a hash, so a claim token never reaches
   * persisted state. An expired lease is reclaimable, which is what lets a
   * crashed controller's lock recover without an operator; a live lease held by
   * someone else is refused, which is what guarantees at most one mutating
   * manager at a time.
   */
  acquireManagerLock({ scope = 'manager-authority', holder, role = 'programme', leaseMs = DEFAULT_LOCK_LEASE_MS, now = this.now() } = {}) {
    const scopeId = requiredId(scope, 'management control lock scope');
    const holderId = requiredId(holder, 'management control lock holder');
    if (!ROLE_SET.has(role)) throw new Error(`unknown management role: ${String(role)}`);
    const boundedLease = Number.isInteger(leaseMs) && leaseMs >= 1_000 && leaseMs <= 60 * 60_000 ? leaseMs : DEFAULT_LOCK_LEASE_MS;
    const timestamp = iso(now, 'management control lock timestamp');
    const holderHash = sha256(holderId);
    const expiresAt = new Date(Date.parse(timestamp) + boundedLease).toISOString();

    return this.runInTransaction(() => {
      const current = this.db.prepare('SELECT * FROM management_control_locks WHERE scope = ?').get(scopeId);
      if (current && current.expires_at > timestamp && current.holder_hash !== holderHash) {
        return Object.freeze({ acquired: false, scope: scopeId, reason: 'manager-authority-held', expiresAt: current.expires_at });
      }
      this.db.prepare(`
        INSERT INTO management_control_locks(scope, holder_hash, role, acquired_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET holder_hash = excluded.holder_hash, role = excluded.role,
          acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
      `).run(scopeId, holderHash, role, timestamp, expiresAt);
      return Object.freeze({ acquired: true, scope: scopeId, reason: null, expiresAt });
    });
  }

  releaseManagerLock({ scope = 'manager-authority', holder } = {}) {
    const scopeId = requiredId(scope, 'management control lock scope');
    const holderHash = sha256(requiredId(holder, 'management control lock holder'));
    const result = this.db.prepare('DELETE FROM management_control_locks WHERE scope = ? AND holder_hash = ?').run(scopeId, holderHash);
    return Object.freeze({ released: Number(result.changes) === 1, scope: scopeId });
  }

  getManagerLock(scope = 'manager-authority') {
    const scopeId = requiredId(scope, 'management control lock scope');
    const row = this.db.prepare('SELECT * FROM management_control_locks WHERE scope = ?').get(scopeId);
    if (!row) return null;
    return Object.freeze({ scope: row.scope, role: row.role, acquiredAt: row.acquired_at, expiresAt: row.expires_at });
  }

  // ---------------------------------------------------------------- decisions

  /**
   * One bounded decision per settled management event. Recording is idempotent
   * on `eventId`: a replayed settlement that reaches the same decision is a
   * no-op, and one that would contradict an existing record fails closed rather
   * than silently overwriting the audit trail.
   */
  recordDecision(decision, { now = this.now() } = {}) {
    if (!isPlainObject(decision)) throw new Error('management control decision must be an object');
    const record = {
      eventId: requiredId(decision.eventId, 'management control decision eventId'),
      projectId: requiredId(decision.projectId, 'management control decision projectId'),
      repository: requiredRepository(decision.repository),
      role: requiredToken(decision.role, 'management control decision role'),
      eventType: requiredToken(decision.eventType, 'management control decision eventType'),
      controlMode: requiredToken(decision.controlMode, 'management control decision controlMode'),
      outcome: requiredToken(decision.outcome, 'management control decision outcome'),
      reason: requiredToken(decision.reason, 'management control decision reason'),
      mutationSuppressed: decision.mutationSuppressed === true,
      issueNumber: optionalPositiveInteger(decision.issueNumber, 'management control decision issueNumber'),
      pullRequestNumber: optionalPositiveInteger(decision.pullRequestNumber, 'management control decision pullRequestNumber'),
      sha: optionalSha(decision.sha, 'management control decision sha'),
      correlationId: requiredId(decision.correlationId, 'management control decision correlationId'),
      successorCount: Number.isInteger(decision.successorCount) && decision.successorCount >= 0 ? decision.successorCount : 0,
    };
    if (!ROLE_SET.has(record.role)) throw new Error(`unknown management role: ${record.role}`);
    if (!MODE_SET.has(record.controlMode)) throw new Error(`unknown management control mode: ${record.controlMode}`);
    const fingerprint = `sha256:${sha256(stableJson(record))}`;
    const timestamp = iso(now, 'management control decision timestamp');

    return this.runInTransaction(() => {
      const existing = this.db.prepare('SELECT * FROM management_control_decisions WHERE event_id = ?').get(record.eventId);
      if (existing) {
        if (existing.decision_fingerprint !== fingerprint) {
          throw new Error(`management control decision for ${record.eventId} already recorded with a different outcome`);
        }
        return Object.freeze({ recorded: false, idempotent: true, eventId: record.eventId, decisionFingerprint: fingerprint });
      }
      this.db.prepare(`
        INSERT INTO management_control_decisions(
          event_id, schema_version, project_id, repo, role, event_type, control_mode,
          outcome, reason, mutation_suppressed, issue_number, pull_request_number,
          exact_sha, correlation_id, successor_count, decision_fingerprint, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.eventId, MANAGEMENT_CONTROL_STORE_SCHEMA_VERSION, record.projectId, record.repository,
        record.role, record.eventType, record.controlMode, record.outcome, record.reason,
        record.mutationSuppressed ? 1 : 0, record.issueNumber, record.pullRequestNumber,
        record.sha, record.correlationId, record.successorCount, fingerprint, timestamp,
      );
      return Object.freeze({ recorded: true, idempotent: false, eventId: record.eventId, decisionFingerprint: fingerprint });
    });
  }

  listDecisions({ projectId = null, limit = 20 } = {}) {
    const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 20;
    const rows = projectId
      ? this.db.prepare('SELECT * FROM management_control_decisions WHERE project_id = ? ORDER BY recorded_at DESC, event_id DESC LIMIT ?')
        .all(requiredId(projectId, 'management control projectId'), bounded)
      : this.db.prepare('SELECT * FROM management_control_decisions ORDER BY recorded_at DESC, event_id DESC LIMIT ?').all(bounded);
    return Object.freeze(rows.map((row) => Object.freeze({
      eventId: row.event_id,
      projectId: row.project_id,
      repository: row.repo,
      role: row.role,
      eventType: row.event_type,
      controlMode: row.control_mode,
      outcome: row.outcome,
      reason: row.reason,
      mutationSuppressed: Number(row.mutation_suppressed) === 1,
      issueNumber: row.issue_number,
      pullRequestNumber: row.pull_request_number,
      sha: row.exact_sha,
      correlationId: row.correlation_id,
      successorCount: Number(row.successor_count),
      decisionFingerprint: row.decision_fingerprint,
      recordedAt: row.recorded_at,
    })));
  }

  // ---------------------------------------------------------------- findings

  /** Record one bounded read-only assurance finding. Identity and class only. */
  recordFinding(finding, { now = this.now() } = {}) {
    if (!isPlainObject(finding)) throw new Error('management control finding must be an object');
    const eventId = requiredId(finding.eventId, 'management control finding eventId');
    const findingClass = requiredToken(finding.findingClass, 'management control finding class');
    const severity = requiredToken(finding.severity, 'management control finding severity');
    if (!SEVERITY_SET.has(severity)) throw new Error(`unknown management finding severity: ${severity}`);
    const projectId = requiredId(finding.projectId, 'management control finding projectId');
    const repository = requiredRepository(finding.repository);
    const correlationId = requiredId(finding.correlationId, 'management control finding correlationId');
    const issueNumber = optionalPositiveInteger(finding.issueNumber, 'management control finding issueNumber');
    const pullRequestNumber = optionalPositiveInteger(finding.pullRequestNumber, 'management control finding pullRequestNumber');
    const sha = optionalSha(finding.sha, 'management control finding sha');
    const timestamp = iso(now, 'management control finding timestamp');
    // Deterministic identity: the same finding for the same event is recorded once.
    const findingId = `mcf-${sha256(stableJson({ eventId, findingClass, projectId, issueNumber, pullRequestNumber, sha })).slice(0, 32)}`;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO management_control_findings(
        finding_id, event_id, project_id, repo, finding_class, severity,
        issue_number, pull_request_number, exact_sha, correlation_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(findingId, eventId, projectId, repository, findingClass, severity, issueNumber, pullRequestNumber, sha, correlationId, timestamp);
    return Object.freeze({ recorded: Number(result.changes) === 1, findingId });
  }

  listFindings({ projectId = null, limit = 50 } = {}) {
    const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50;
    const rows = projectId
      ? this.db.prepare('SELECT * FROM management_control_findings WHERE project_id = ? ORDER BY recorded_at DESC, finding_id DESC LIMIT ?')
        .all(requiredId(projectId, 'management control projectId'), bounded)
      : this.db.prepare('SELECT * FROM management_control_findings ORDER BY recorded_at DESC, finding_id DESC LIMIT ?').all(bounded);
    return Object.freeze(rows.map((row) => Object.freeze({
      findingId: row.finding_id,
      eventId: row.event_id,
      projectId: row.project_id,
      repository: row.repo,
      findingClass: row.finding_class,
      severity: row.severity,
      issueNumber: row.issue_number,
      pullRequestNumber: row.pull_request_number,
      sha: row.exact_sha,
      correlationId: row.correlation_id,
      recordedAt: row.recorded_at,
    })));
  }

  // ---------------------------------------------------------------- projections

  /**
   * Persist one project status projection, deduplicated by fingerprint.
   *
   * An identical semantic projection is *not* rewritten: neither the revision
   * nor the timestamp moves, so a dashboard polling a quiescent project sees a
   * stable record instead of churn. Only a real semantic change advances the
   * revision.
   */
  recordProjection({ projectId, repository, fingerprint, payload, now = this.now() } = {}) {
    const id = requiredId(projectId, 'management control projection projectId');
    const repo = requiredRepository(repository);
    const printed = requiredFingerprint(fingerprint, 'management control projection fingerprint');
    if (!isPlainObject(payload)) throw new Error('management control projection payload must be an object');
    const serialized = stableJson(payload);
    if (serialized.length > 32_768) throw new Error('management control projection payload exceeds the bounded size');
    const timestamp = iso(now, 'management control projection timestamp');

    return this.runInTransaction(() => {
      const existing = this.db.prepare('SELECT * FROM management_control_projections WHERE project_id = ?').get(id);
      if (existing && existing.fingerprint === printed) {
        return Object.freeze({ changed: false, projectId: id, revision: Number(existing.revision), fingerprint: printed, updatedAt: existing.updated_at });
      }
      const revision = existing ? Number(existing.revision) + 1 : 1;
      this.db.prepare(`
        INSERT INTO management_control_projections(project_id, repo, revision, fingerprint, payload, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET repo = excluded.repo, revision = excluded.revision,
          fingerprint = excluded.fingerprint, payload = excluded.payload, updated_at = excluded.updated_at
      `).run(id, repo, revision, printed, serialized, timestamp);
      return Object.freeze({ changed: true, projectId: id, revision, fingerprint: printed, updatedAt: timestamp });
    });
  }

  getProjection(projectId) {
    const id = requiredId(projectId, 'management control projection projectId');
    const row = this.db.prepare('SELECT * FROM management_control_projections WHERE project_id = ?').get(id);
    if (!row) return null;
    return Object.freeze({
      projectId: row.project_id,
      repository: row.repo,
      revision: Number(row.revision),
      fingerprint: row.fingerprint,
      payload: Object.freeze(JSON.parse(row.payload)),
      updatedAt: row.updated_at,
    });
  }

  listProjections({ limit = 50 } = {}) {
    const bounded = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50;
    return Object.freeze(this.db.prepare('SELECT project_id FROM management_control_projections ORDER BY project_id ASC LIMIT ?')
      .all(bounded).map((row) => this.getProjection(row.project_id)));
  }

  // ---------------------------------------------------------------- observations

  /**
   * Append one bounded operational observation. `detail` is a bounded token,
   * never free text, so no log line, prompt or provider output can enter the
   * observation trail.
   */
  recordObservation({ signal, projectId = null, repository = null, eventId = null, eventType = null, role = null, controlMode = null, detail = 'none', now = this.now() } = {}) {
    if (!nonEmptyString(signal) || !SIGNAL_SET.has(signal)) throw new Error(`unknown management observation signal: ${String(signal ?? '')}`);
    const timestamp = iso(now, 'management control observation timestamp');
    this.db.prepare(`
      INSERT INTO management_control_observations(signal, project_id, repo, event_id, event_type, role, control_mode, detail, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      signal,
      projectId == null ? null : requiredId(projectId, 'management control observation projectId'),
      repository == null ? null : requiredRepository(repository),
      eventId == null ? null : requiredId(eventId, 'management control observation eventId'),
      eventType == null ? null : requiredToken(eventType, 'management control observation eventType'),
      role == null ? null : requiredToken(role, 'management control observation role'),
      controlMode == null ? null : requiredToken(controlMode, 'management control observation controlMode'),
      requiredToken(detail, 'management control observation detail'),
      timestamp,
    );
    // Bounded retention: the observation trail is operational evidence, not an
    // unbounded log, so the oldest rows are trimmed rather than accumulated.
    this.db.prepare(`
      DELETE FROM management_control_observations
      WHERE observation_id NOT IN (
        SELECT observation_id FROM management_control_observations ORDER BY observation_id DESC LIMIT ?
      )
    `).run(MAX_OBSERVATIONS);
    return Object.freeze({ recorded: true, signal });
  }

  listObservations({ limit = 50 } = {}) {
    const bounded = Number.isInteger(limit) && limit >= 1 && limit <= MAX_OBSERVATIONS ? limit : 50;
    return Object.freeze(this.db.prepare('SELECT * FROM management_control_observations ORDER BY observation_id DESC LIMIT ?')
      .all(bounded).map((row) => Object.freeze({
        observationId: Number(row.observation_id),
        signal: row.signal,
        projectId: row.project_id,
        repository: row.repo,
        eventId: row.event_id,
        eventType: row.event_type,
        role: row.role,
        controlMode: row.control_mode,
        detail: row.detail,
        recordedAt: row.recorded_at,
      })));
  }

  close() {
    this.db.close();
  }
}
