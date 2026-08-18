import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ATTENTION_RECONCILIATION_STORE_SCHEMA_VERSION = 1;

const json = (v) => JSON.stringify(v ?? null);

const parse = (r) => r && Object.freeze({
  repository: r.repository,
  issueNumber: r.issue_number,
  status: r.status,
  reasonCode: r.reason_code,
  githubState: r.github_state,
  githubStateReason: r.github_state_reason,
  evidence: r.evidence_json ? Object.freeze(JSON.parse(r.evidence_json)) : null,
  checkedAt: r.checked_at,
  reconciliationCount: r.reconciliation_count,
  acknowledgedStatus: r.acknowledged_status,
  acknowledgedReasonCode: r.acknowledged_reason_code,
  acknowledgedBy: r.acknowledged_by,
  acknowledgedAt: r.acknowledged_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * One durable, repository-qualified reconciliation row per (repository,
 * issue_number). Never deletes or replaces the original `attention_events`
 * evidence -- this is a separate, additive projection recording the most
 * recent GitHub-state decision as an auditable state transition (each write
 * bumps `reconciliation_count` and `updated_at`, and prior automatic
 * decisions are always superseded, never erased destructively, by the next
 * verified read). An optional operator acknowledgement is tracked in its own
 * columns, distinct from the automatic decision, so a manual override is
 * always distinguishable from an inferred one.
 */
export class AttentionReconciliationStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (!dbPath) throw new Error('attention reconciliation db path is required');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS attention_reconciliation_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attention_reconciliations(
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('actionable','historical','unknown')),
        reason_code TEXT NOT NULL,
        github_state TEXT,
        github_state_reason TEXT,
        evidence_json TEXT,
        checked_at TEXT NOT NULL,
        reconciliation_count INTEGER NOT NULL DEFAULT 1,
        acknowledged_status TEXT CHECK(acknowledged_status IS NULL OR acknowledged_status IN ('actionable','historical')),
        acknowledged_reason_code TEXT,
        acknowledged_by TEXT,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository, issue_number)
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO attention_reconciliation_schema VALUES(?,?)').run(ATTENTION_RECONCILIATION_STORE_SCHEMA_VERSION, this.now());
  }

  get(repository, issueNumber) {
    return parse(this.db.prepare('SELECT * FROM attention_reconciliations WHERE repository = ? AND issue_number = ?').get(repository, issueNumber));
  }

  /** Repository-qualified listing, never a global/cross-repository scan. */
  listForRepository(repository) {
    return this.db.prepare('SELECT * FROM attention_reconciliations WHERE repository = ? ORDER BY issue_number').all(repository).map(parse);
  }

  /**
   * Idempotent upsert of the automatic GitHub-state decision. Replaying the
   * exact same decision still bumps `reconciliation_count`/`updated_at` (an
   * auditable re-verification), never deletes the row, and never touches the
   * separate acknowledgement columns.
   */
  upsert({ repository, issueNumber, status, reasonCode, githubState = null, githubStateReason = null, evidence = null, now = this.now() } = {}) {
    this.db.prepare(`
      INSERT INTO attention_reconciliations(
        repository, issue_number, status, reason_code, github_state, github_state_reason, evidence_json,
        checked_at, reconciliation_count, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(repository, issue_number) DO UPDATE SET
        status = excluded.status,
        reason_code = excluded.reason_code,
        github_state = excluded.github_state,
        github_state_reason = excluded.github_state_reason,
        evidence_json = excluded.evidence_json,
        checked_at = excluded.checked_at,
        reconciliation_count = attention_reconciliations.reconciliation_count + 1,
        updated_at = excluded.updated_at
    `).run(repository, issueNumber, status, reasonCode, githubState, githubStateReason, json(evidence), now, now, now);
    return this.get(repository, issueNumber);
  }

  /**
   * Explicit, audited manager/operator override for a condition that cannot
   * be inferred safely from GitHub state alone. Requires a bounded actor
   * identity and reason; never invoked implicitly by reading/opening a
   * dashboard.
   */
  acknowledge({ repository, issueNumber, status, reasonCode, actor, now = this.now() } = {}) {
    if (status !== 'actionable' && status !== 'historical') throw new Error('acknowledge requires an explicit actionable|historical status');
    if (typeof actor !== 'string' || !actor.trim()) throw new Error('acknowledge requires an actor identity');
    if (typeof reasonCode !== 'string' || !reasonCode.trim()) throw new Error('acknowledge requires a reason code');
    const existing = this.get(repository, issueNumber);
    if (!existing) throw new Error('cannot acknowledge a repository/issue with no reconciliation record');
    this.db.prepare(`
      UPDATE attention_reconciliations
      SET acknowledged_status = ?, acknowledged_reason_code = ?, acknowledged_by = ?, acknowledged_at = ?, updated_at = ?
      WHERE repository = ? AND issue_number = ?
    `).run(status, reasonCode, actor, now, now, repository, issueNumber);
    return this.get(repository, issueNumber);
  }

  close() { this.db.close(); }
}

/**
 * Genuinely read-only, repository-qualified projection of already-recorded
 * reconciliation decisions, for the status/dashboard read path. Never
 * creates the DB file/directory and never opens it for writing -- a missing
 * or unreadable reconciliation DB simply yields an empty list, never an
 * error, since reading dashboard/status must never itself be a reconciling
 * action.
 */
export function readAttentionReconciliationsForRepository(dbPath, repository) {
  if (!dbPath || !repository || !existsSync(dbPath)) return [];
  let db;
  try {
    const url = pathToFileURL(dbPath);
    url.searchParams.set('mode', 'ro');
    db = new DatabaseSync(url.href, { readOnly: true });
    return db.prepare('SELECT * FROM attention_reconciliations WHERE repository = ? ORDER BY issue_number').all(repository).map(parse);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
