import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ATTENTION_RECONCILIATION_STORE_SCHEMA_VERSION = 2;
const ACK_REASONS = new Set(['manager-confirmed-actionable', 'manager-confirmed-historical', 'post-closure-action-required']);
const hash = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

const parseItem = (row) => row && Object.freeze({
  repository: row.repository, eventKey: row.event_identity, eventRevision: row.event_revision,
  attentionEventId: row.source_row_id, issueNumber: row.issue_number, generationId: row.generation_id,
  status: row.status, reasonCode: row.reason_code, githubState: row.github_state,
  githubStateReason: row.github_state_reason, githubEvidenceRevision: row.github_evidence_revision,
  checkedAt: row.checked_at,
});

const parseAck = (row) => row && Object.freeze({
  id: row.ack_event_id, action: row.action, targetId: row.target_ack_event_id,
  repository: row.repository, eventKey: row.event_identity, eventRevision: row.event_revision,
  githubEvidenceRevision: row.github_evidence_revision, status: row.decision_status,
  reasonCode: row.reason_code, actor: row.actor, acknowledgedAt: row.created_at, expiresAt: row.expires_at,
});

function assertIdentifier(value, label, pattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
}

export class AttentionReconciliationStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (!dbPath) throw new Error('attention reconciliation db path is required');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS attention_reconciliation_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attention_reconciliation_generations_v2(
        generation_id TEXT PRIMARY KEY, repository TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('completed','failed','superseded')),
        source_snapshot_digest TEXT NOT NULL, source_event_count INTEGER NOT NULL,
        started_at TEXT NOT NULL, completed_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        failure_code TEXT, checked_issue_count INTEGER NOT NULL, unknown_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attention_reconciliation_generation_items_v2(
        generation_id TEXT NOT NULL, event_identity TEXT NOT NULL, event_revision TEXT NOT NULL,
        source_row_id INTEGER, repository TEXT NOT NULL, issue_number INTEGER NOT NULL,
        github_evidence_revision TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('actionable','historical','unknown')),
        reason_code TEXT NOT NULL, github_state TEXT, github_state_reason TEXT, checked_at TEXT NOT NULL,
        PRIMARY KEY(generation_id,event_identity),
        FOREIGN KEY(generation_id) REFERENCES attention_reconciliation_generations_v2(generation_id)
      );
      CREATE TABLE IF NOT EXISTS attention_reconciliation_current_v2(
        repository TEXT PRIMARY KEY, generation_id TEXT NOT NULL UNIQUE, published_at TEXT NOT NULL,
        FOREIGN KEY(generation_id) REFERENCES attention_reconciliation_generations_v2(generation_id)
      );
      CREATE TABLE IF NOT EXISTS attention_reconciliation_transitions_v2(
        transition_id TEXT PRIMARY KEY, event_identity TEXT NOT NULL, repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL, event_revision TEXT NOT NULL, github_evidence_revision TEXT NOT NULL,
        from_status TEXT, to_status TEXT NOT NULL, reason_code TEXT NOT NULL,
        generation_id TEXT NOT NULL, observed_at TEXT NOT NULL, evidence_digest TEXT NOT NULL,
        FOREIGN KEY(generation_id) REFERENCES attention_reconciliation_generations_v2(generation_id)
      );
      CREATE TABLE IF NOT EXISTS attention_reconciliation_ack_events_v2(
        ack_event_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
        target_ack_event_id TEXT, event_identity TEXT NOT NULL, repository TEXT NOT NULL,
        event_revision TEXT NOT NULL, github_evidence_revision TEXT NOT NULL,
        decision_status TEXT CHECK(decision_status IS NULL OR decision_status IN ('actionable','historical')),
        reason_code TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attention_reconciliation_generations_repo_v2
        ON attention_reconciliation_generations_v2(repository,state,completed_at);
      CREATE INDEX IF NOT EXISTS attention_reconciliation_transitions_event_v2
        ON attention_reconciliation_transitions_v2(event_identity,observed_at);
    `);
    this.db.prepare('INSERT OR IGNORE INTO attention_reconciliation_schema VALUES(?,?)')
      .run(ATTENTION_RECONCILIATION_STORE_SCHEMA_VERSION, this.now());
  }

  publishGeneration({ generationId, repository, sourceSnapshotDigest, sourceEventCount, startedAt, completedAt, expiresAt, decisions, checkedIssueCount } = {}) {
    assertIdentifier(generationId, 'generationId');
    assertIdentifier(repository, 'repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    if (!Array.isArray(decisions) || decisions.some((item) => item.repository !== repository)) throw new Error('generation decisions are invalid');
    const previous = new Map(this.listStateForRepository(repository).items.map((item) => [item.eventKey, item]));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO attention_reconciliation_generations_v2
        (generation_id,repository,state,source_snapshot_digest,source_event_count,started_at,completed_at,expires_at,
         failure_code,checked_issue_count,unknown_count) VALUES(?,?,'completed',?,?,?,?,?,NULL,?,?)`)
        .run(generationId, repository, sourceSnapshotDigest, sourceEventCount, startedAt, completedAt, expiresAt,
          checkedIssueCount, decisions.filter((item) => item.status === 'unknown').length);
      const insertItem = this.db.prepare(`INSERT INTO attention_reconciliation_generation_items_v2
        (generation_id,event_identity,event_revision,source_row_id,repository,issue_number,github_evidence_revision,
         status,reason_code,github_state,github_state_reason,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertTransition = this.db.prepare(`INSERT OR IGNORE INTO attention_reconciliation_transitions_v2
        (transition_id,event_identity,repository,issue_number,event_revision,github_evidence_revision,from_status,
         to_status,reason_code,generation_id,observed_at,evidence_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of decisions) {
        insertItem.run(generationId, item.eventKey, item.eventRevision, item.attentionEventId, repository, item.issueNumber,
          item.githubEvidenceRevision, item.status, item.reasonCode, item.githubState, item.githubStateReason, item.checkedAt);
        const before = previous.get(item.eventKey)?.status ?? null;
        const transitionId = hash({ eventKey: item.eventKey, eventRevision: item.eventRevision, githubEvidenceRevision: item.githubEvidenceRevision, status: item.status, reasonCode: item.reasonCode });
        insertTransition.run(transitionId, item.eventKey, repository, item.issueNumber, item.eventRevision,
          item.githubEvidenceRevision, before, item.status, item.reasonCode, generationId, completedAt,
          hash({ eventRevision: item.eventRevision, githubEvidenceRevision: item.githubEvidenceRevision }));
      }
      this.db.prepare(`INSERT INTO attention_reconciliation_current_v2(repository,generation_id,published_at)
        VALUES(?,?,?) ON CONFLICT(repository) DO UPDATE SET generation_id=excluded.generation_id,published_at=excluded.published_at`)
        .run(repository, generationId, completedAt);
      this.db.exec('COMMIT');
      return this.listStateForRepository(repository);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  acknowledge({ repository, eventKey, eventRevision, githubEvidenceRevision, status, reasonCode, actor, expiresAt, now = this.now() } = {}) {
    if (!['actionable', 'historical'].includes(status) || !ACK_REASONS.has(reasonCode)) throw new Error('acknowledgement decision is invalid');
    assertIdentifier(eventKey, 'eventKey'); assertIdentifier(eventRevision, 'eventRevision');
    assertIdentifier(githubEvidenceRevision, 'githubEvidenceRevision'); assertIdentifier(actor, 'actor');
    const lifetime = Date.parse(expiresAt) - Date.parse(now);
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 7 * 24 * 60 * 60 * 1000) throw new Error('acknowledgement expiry is invalid');
    const current = this.listStateForRepository(repository).items.find((item) => item.eventKey === eventKey);
    if (!current || current.eventRevision !== eventRevision || current.githubEvidenceRevision !== githubEvidenceRevision) throw new Error('acknowledgement evidence is not current');
    if (current.status === 'historical' && status === 'actionable' && reasonCode !== 'post-closure-action-required') {
      throw new Error('closed attention requires a post-closure action reason');
    }
    const id = hash({ action: 'grant', repository, eventKey, eventRevision, githubEvidenceRevision, status, reasonCode, actor, now, expiresAt });
    this.db.prepare(`INSERT OR IGNORE INTO attention_reconciliation_ack_events_v2
      (ack_event_id,action,target_ack_event_id,event_identity,repository,event_revision,github_evidence_revision,
       decision_status,reason_code,actor,created_at,expires_at) VALUES(?,'grant',NULL,?,?,?,?,?,?,?,?,?)`)
      .run(id, eventKey, repository, eventRevision, githubEvidenceRevision, status, reasonCode, actor, now, expiresAt);
    return parseAck(this.db.prepare('SELECT * FROM attention_reconciliation_ack_events_v2 WHERE ack_event_id=?').get(id));
  }

  revokeAcknowledgement({ acknowledgementId, actor, now = this.now() } = {}) {
    assertIdentifier(acknowledgementId, 'acknowledgementId'); assertIdentifier(actor, 'actor');
    const target = parseAck(this.db.prepare('SELECT * FROM attention_reconciliation_ack_events_v2 WHERE ack_event_id=? AND action=\'grant\'').get(acknowledgementId));
    if (!target) throw new Error('acknowledgement does not exist');
    const id = hash({ action: 'revoke', target: acknowledgementId, actor, now });
    this.db.prepare(`INSERT OR IGNORE INTO attention_reconciliation_ack_events_v2
      (ack_event_id,action,target_ack_event_id,event_identity,repository,event_revision,github_evidence_revision,
       decision_status,reason_code,actor,created_at,expires_at) VALUES(?,'revoke',?,?,?,?,?,NULL,'manager-revoked',?,?,?)`)
      .run(id, acknowledgementId, target.eventKey, target.repository, target.eventRevision,
        target.githubEvidenceRevision, actor, now, now);
    return parseAck(this.db.prepare('SELECT * FROM attention_reconciliation_ack_events_v2 WHERE ack_event_id=?').get(id));
  }

  listStateForRepository(repository) {
    const generation = this.db.prepare(`SELECT g.* FROM attention_reconciliation_current_v2 c
      JOIN attention_reconciliation_generations_v2 g ON g.generation_id=c.generation_id WHERE c.repository=?`).get(repository);
    const items = generation ? this.db.prepare(`SELECT * FROM attention_reconciliation_generation_items_v2
      WHERE generation_id=? ORDER BY source_row_id,event_identity`).all(generation.generation_id).map(parseItem) : [];
    const acknowledgements = this.db.prepare(`SELECT * FROM attention_reconciliation_ack_events_v2
      WHERE repository=? ORDER BY created_at,ack_event_id`).all(repository).map(parseAck);
    return Object.freeze({
      generation: generation ? Object.freeze({ id: generation.generation_id, state: generation.state, sourceSnapshotDigest: generation.source_snapshot_digest, sourceEventCount: generation.source_event_count, completedAt: generation.completed_at, expiresAt: generation.expires_at }) : null,
      items: Object.freeze(items), acknowledgements: Object.freeze(acknowledgements),
    });
  }

  transitionCount(repository, eventKey = null) {
    return eventKey
      ? this.db.prepare('SELECT COUNT(*) count FROM attention_reconciliation_transitions_v2 WHERE repository=? AND event_identity=?').get(repository, eventKey).count
      : this.db.prepare('SELECT COUNT(*) count FROM attention_reconciliation_transitions_v2 WHERE repository=?').get(repository).count;
  }

  close() { this.db.close(); }
}

export function readAttentionReconciliationState(dbPath, repository) {
  const empty = Object.freeze({ generation: null, items: Object.freeze([]), acknowledgements: Object.freeze([]) });
  if (!dbPath || !repository || !existsSync(dbPath)) return empty;
  let db;
  try {
    const url = pathToFileURL(dbPath); url.searchParams.set('mode', 'ro'); url.searchParams.set('immutable', '1');
    db = new DatabaseSync(url.href, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!tables.has('attention_reconciliation_current_v2')) return empty;
    const generation = db.prepare(`SELECT g.* FROM attention_reconciliation_current_v2 c
      JOIN attention_reconciliation_generations_v2 g ON g.generation_id=c.generation_id WHERE c.repository=?`).get(repository);
    const items = generation ? db.prepare('SELECT * FROM attention_reconciliation_generation_items_v2 WHERE generation_id=? ORDER BY source_row_id,event_identity').all(generation.generation_id).map(parseItem) : [];
    const acknowledgements = db.prepare('SELECT * FROM attention_reconciliation_ack_events_v2 WHERE repository=? ORDER BY created_at,ack_event_id').all(repository).map(parseAck);
    return Object.freeze({
      generation: generation ? Object.freeze({ id: generation.generation_id, state: generation.state, sourceSnapshotDigest: generation.source_snapshot_digest, sourceEventCount: generation.source_event_count, completedAt: generation.completed_at, expiresAt: generation.expires_at }) : null,
      items: Object.freeze(items), acknowledgements: Object.freeze(acknowledgements),
    });
  } catch { return empty; } finally { db?.close(); }
}
