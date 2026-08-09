import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReconciliationError } from './agent-runner-issue-reconciliation.mjs';

export const ISSUE_RECONCILIATION_STORE_SCHEMA_VERSION = 1;

const json = (v) => {
  const s = JSON.stringify(v ?? {});
  if (Buffer.byteLength(s) > 65536) throw new ReconciliationError('invalid-request', 'reconciliation payload exceeds bound');
  return s;
};

const parse = (r) => r && Object.freeze({
  transactionId: r.transaction_id,
  idempotencyKey: r.idempotency_key,
  mergeTransactionId: r.merge_transaction_id,
  projectId: r.project_id,
  repository: r.repository,
  issueNumber: r.issue_number,
  prNumber: r.pr_number,
  sourceBranch: r.source_branch,
  targetBranch: r.target_branch,
  expectedHeadSha: r.expected_head_sha,
  expectedMergeCommitSha: r.expected_merge_commit_sha,
  state: r.state,
  reasonCode: r.reason_code,
  requestJson: Object.freeze(JSON.parse(r.request_json)),
  result: Object.freeze(JSON.parse(r.result_json)),
  beforeEvidence: r.before_evidence_json && Object.freeze(JSON.parse(r.before_evidence_json)),
  intendedEvidence: r.intended_evidence_json && Object.freeze(JSON.parse(r.intended_evidence_json)),
  readbackEvidence: r.readback_evidence_json && Object.freeze(JSON.parse(r.readback_evidence_json)),
  remoteBranchState: r.remote_branch_state,
  remoteBranchReasonCode: r.remote_branch_reason_code,
  remoteBranchBeforeJson: r.remote_branch_before_json && Object.freeze(JSON.parse(r.remote_branch_before_json)),
  remoteBranchReadbackJson: r.remote_branch_readback_json && Object.freeze(JSON.parse(r.remote_branch_readback_json)),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Durable, restart-safe record of one post-merge issue-reconciliation
 * decision, one row per merge-transaction identity. States: pending
 * (recorded, evidence not yet acted on) -> issue_closed (GitHub confirmed
 * the label/close writes; the point of no return) -> completed (read-back
 * confirmed). `attention` is not a point of no return -- it only records the
 * most recent refusal reason for observability; a retry re-reads live
 * evidence rather than trusting it. Remote-branch deletion is tracked
 * separately in the same row (`remote_branch_state`) since it is a distinct,
 * independently-idempotent action gated on `state = 'completed'`.
 */
export class IssueReconciliationStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (!dbPath) throw new Error('issue reconciliation db path is required');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS issue_reconciliation_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issue_reconciliations(
        transaction_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        merge_transaction_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        pr_number INTEGER NOT NULL,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        expected_head_sha TEXT NOT NULL,
        expected_merge_commit_sha TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','issue_closed','completed','attention')),
        reason_code TEXT,
        request_json TEXT NOT NULL,
        before_evidence_json TEXT,
        intended_evidence_json TEXT,
        readback_evidence_json TEXT,
        remote_branch_state TEXT CHECK(remote_branch_state IS NULL OR remote_branch_state IN ('deleted','attention')),
        remote_branch_reason_code TEXT,
        remote_branch_before_json TEXT,
        remote_branch_readback_json TEXT,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS issue_reconciliation_active ON issue_reconciliations(project_id, repository, issue_number, state);
    `);
    this.db.prepare('INSERT OR IGNORE INTO issue_reconciliation_schema VALUES(?,?)').run(ISSUE_RECONCILIATION_STORE_SCHEMA_VERSION, this.now());
  }

  getTransaction(id) { return parse(this.db.prepare('SELECT * FROM issue_reconciliations WHERE transaction_id=?').get(id)); }

  findByIdempotencyKey(k) { return parse(this.db.prepare('SELECT * FROM issue_reconciliations WHERE idempotency_key=?').get(k)); }

  findByMergeTransactionId(id) { return parse(this.db.prepare('SELECT * FROM issue_reconciliations WHERE merge_transaction_id=?').get(id)); }

  beginReconciliation(r, { now = this.now() } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.findByIdempotencyKey(r.idempotencyKey);
      if (existing) { this.db.exec('COMMIT'); return { inserted: false, reconciliation: existing }; }
      const active = this.db.prepare(`
        SELECT 1 FROM issue_reconciliations
        WHERE project_id=? AND repository=? AND issue_number=? AND state IN ('pending','issue_closed')
      `).get(r.projectId, r.repository, r.issueNumber);
      if (active) throw new ReconciliationError('concurrent-reconciliation-active', 'another reconciliation is active for this issue');
      this.db.prepare(`
        INSERT INTO issue_reconciliations(
          transaction_id, idempotency_key, merge_transaction_id, project_id, repository, issue_number, pr_number,
          source_branch, target_branch, expected_head_sha, expected_merge_commit_sha,
          state, request_json, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)
      `).run(
        r.transactionId, r.idempotencyKey, r.mergeTransactionId, r.projectId, r.repository, r.issueNumber, r.prNumber,
        r.sourceBranch, r.targetBranch, r.expectedHeadSha, r.expectedMergeCommitSha,
        json(r), now, now,
      );
      this.db.exec('COMMIT');
      return { inserted: true, reconciliation: this.getTransaction(r.transactionId) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* no-op: nothing to roll back */ }
      throw error;
    }
  }

  recordIssueClosed(id, { before, intended, now = this.now() } = {}) {
    const q = this.db.prepare(`
      UPDATE issue_reconciliations
      SET state='issue_closed', reason_code=NULL, before_evidence_json=?, intended_evidence_json=?, updated_at=?
      WHERE transaction_id=? AND state IN ('pending','attention')
    `).run(json(before), json(intended), now, id);
    return q.changes ? this.getTransaction(id) : null;
  }

  completeReconciliation(id, { result, readback, now = this.now() } = {}) {
    const q = this.db.prepare(`
      UPDATE issue_reconciliations SET state='completed', result_json=?, readback_evidence_json=?, updated_at=?
      WHERE transaction_id=? AND state='issue_closed'
    `).run(json(result), json(readback), now, id);
    if (!q.changes) throw new ReconciliationError('reconciliation-not-completable', 'reconciliation not completable');
    return this.getTransaction(id);
  }

  attentionReconciliation(id, { reasonCode, before = null, now = this.now() } = {}) {
    this.db.prepare(`
      UPDATE issue_reconciliations SET state='attention', reason_code=?, before_evidence_json=COALESCE(?,before_evidence_json), updated_at=?
      WHERE transaction_id=? AND state IN ('pending','attention')
    `).run(reasonCode, before ? json(before) : null, now, id);
    return this.getTransaction(id);
  }

  recordRemoteBranchDeleted(id, { before, readback, now = this.now() } = {}) {
    const q = this.db.prepare(`
      UPDATE issue_reconciliations
      SET remote_branch_state='deleted', remote_branch_reason_code=NULL, remote_branch_before_json=?, remote_branch_readback_json=?, updated_at=?
      WHERE transaction_id=? AND state='completed' AND (remote_branch_state IS NULL OR remote_branch_state='attention')
    `).run(json(before), json(readback), now, id);
    return q.changes ? this.getTransaction(id) : null;
  }

  attentionRemoteBranch(id, { reasonCode, now = this.now() } = {}) {
    this.db.prepare(`
      UPDATE issue_reconciliations SET remote_branch_state='attention', remote_branch_reason_code=?, updated_at=?
      WHERE transaction_id=? AND state='completed' AND (remote_branch_state IS NULL OR remote_branch_state='attention')
    `).run(reasonCode, now, id);
    return this.getTransaction(id);
  }

  close() { this.db.close(); }
}
