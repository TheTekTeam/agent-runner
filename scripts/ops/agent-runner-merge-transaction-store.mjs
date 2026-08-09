import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MergePolicyError } from './agent-runner-merge-policy.mjs';

export const MERGE_TRANSACTION_SCHEMA_VERSION = 1;

const json = (v) => {
  const s = JSON.stringify(v ?? {});
  if (Buffer.byteLength(s) > 65536) throw new MergePolicyError('invalid-request', 'transaction payload exceeds bound');
  return s;
};

const parse = (r) => r && Object.freeze({
  transactionId: r.transaction_id,
  idempotencyKey: r.idempotency_key,
  projectId: r.project_id,
  repository: r.repository,
  issueNumber: r.issue_number,
  prNumber: r.pr_number,
  sourceBranch: r.source_branch,
  targetBranch: r.target_branch,
  expectedHeadSha: r.expected_head_sha,
  expectedBaseSha: r.expected_base_sha,
  managerRevision: r.manager_revision,
  managerFingerprint: r.manager_fingerprint,
  executorJobId: r.executor_job_id,
  riskClass: r.risk_class,
  state: r.state,
  mergeCommitSha: r.merge_commit_sha,
  requestJson: Object.freeze(JSON.parse(r.request_json)),
  result: Object.freeze(JSON.parse(r.result_json)),
  beforeEvidence: r.before_evidence_json && Object.freeze(JSON.parse(r.before_evidence_json)),
  intendedEvidence: r.intended_evidence_json && Object.freeze(JSON.parse(r.intended_evidence_json)),
  readbackEvidence: r.readback_evidence_json && Object.freeze(JSON.parse(r.readback_evidence_json)),
  settlementStatus: r.settlement_status,
  settlementFingerprint: r.settlement_fingerprint,
  settlementReasonCode: r.settlement_reason_code,
  errorCode: r.error_code,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Durable, restart-safe record of one merge decision/transaction. States:
 * pending (recorded, not yet merged) -> github_merged (GitHub confirmed the
 * merge; the point of no return) -> completed (read-back confirmed and
 * settlement observation started). A row can only ever reach github_merged
 * once, so a crash between GitHub confirming the merge and this store being
 * updated is the only ambiguity window; execution always re-reads live PR
 * state before ever attempting a second PUT merge call.
 */
export class MergeTransactionStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (!dbPath) throw new Error('merge transaction db path is required');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS merge_transaction_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS merge_transactions(
        transaction_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        pr_number INTEGER NOT NULL,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        expected_head_sha TEXT NOT NULL,
        expected_base_sha TEXT NOT NULL,
        manager_revision TEXT NOT NULL,
        manager_fingerprint TEXT NOT NULL,
        executor_job_id TEXT NOT NULL,
        risk_class TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','github_merged','completed','failed')),
        merge_commit_sha TEXT,
        request_json TEXT NOT NULL,
        before_evidence_json TEXT,
        intended_evidence_json TEXT,
        readback_evidence_json TEXT,
        settlement_status TEXT CHECK(settlement_status IS NULL OR settlement_status IN ('pending','succeeded','failed')),
        settlement_fingerprint TEXT,
        settlement_reason_code TEXT,
        result_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS merge_tx_active ON merge_transactions(project_id, repository, pr_number, state);
    `);
    this.db.prepare('INSERT OR IGNORE INTO merge_transaction_schema VALUES(?,?)').run(MERGE_TRANSACTION_SCHEMA_VERSION, this.now());
  }

  getTransaction(id) { return parse(this.db.prepare('SELECT * FROM merge_transactions WHERE transaction_id=?').get(id)); }

  findByIdempotencyKey(k) { return parse(this.db.prepare('SELECT * FROM merge_transactions WHERE idempotency_key=?').get(k)); }

  beginTransaction(r, { now = this.now() } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.findByIdempotencyKey(r.idempotencyKey);
      if (existing) { this.db.exec('COMMIT'); return { inserted: false, transaction: existing }; }
      const active = this.db.prepare(`
        SELECT 1 FROM merge_transactions
        WHERE project_id=? AND repository=? AND pr_number=? AND state IN ('pending','github_merged')
      `).get(r.projectId, r.repository, r.prNumber);
      if (active) throw new MergePolicyError('concurrent-transaction-active', 'another merge transaction is active for this pull request');
      this.db.prepare(`
        INSERT INTO merge_transactions(
          transaction_id, idempotency_key, project_id, repository, issue_number, pr_number,
          source_branch, target_branch, expected_head_sha, expected_base_sha,
          manager_revision, manager_fingerprint, executor_job_id, risk_class,
          state, request_json, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)
      `).run(
        r.transactionId, r.idempotencyKey, r.projectId, r.repository, r.issueNumber, r.prNumber,
        r.sourceBranch, r.targetBranch, r.expectedHeadSha, r.expectedBaseSha,
        r.managerRevision, r.managerFingerprint, r.executorJobId, r.riskClass,
        json(r), now, now,
      );
      this.db.exec('COMMIT');
      return { inserted: true, transaction: this.getTransaction(r.transactionId) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* no-op: nothing to roll back */ }
      throw error;
    }
  }

  recordGithubMerged(id, { before, intended, mergeCommitSha, now = this.now() } = {}) {
    const q = this.db.prepare(`
      UPDATE merge_transactions
      SET state='github_merged', merge_commit_sha=?, before_evidence_json=?, intended_evidence_json=?, updated_at=?
      WHERE transaction_id=? AND state='pending'
    `).run(mergeCommitSha, json(before), json(intended), now, id);
    return q.changes ? this.getTransaction(id) : null;
  }

  completeTransaction(id, { result, readback, now = this.now() } = {}) {
    const q = this.db.prepare(`
      UPDATE merge_transactions SET state='completed', result_json=?, readback_evidence_json=?, updated_at=?
      WHERE transaction_id=? AND state='github_merged'
    `).run(json(result), json(readback), now, id);
    if (!q.changes) throw new MergePolicyError('transaction-not-completable', 'merge transaction not completable');
    return this.getTransaction(id);
  }

  failTransaction(id, { errorCode, result = {}, now = this.now() } = {}) {
    this.db.prepare(`
      UPDATE merge_transactions SET state='failed', error_code=?, result_json=?, updated_at=?
      WHERE transaction_id=? AND state IN ('pending','github_merged')
    `).run(errorCode, json(result), now, id);
    return this.getTransaction(id);
  }

  /** Additive post-merge settlement evidence. Never changes transaction state. */
  recordSettlement(id, { status, fingerprint = null, reasonCode = null, now = this.now() } = {}) {
    const q = this.db.prepare(`
      UPDATE merge_transactions SET settlement_status=?, settlement_fingerprint=?, settlement_reason_code=?, updated_at=?
      WHERE transaction_id=? AND state IN ('github_merged','completed')
    `).run(status, fingerprint, reasonCode, now, id);
    return q.changes ? this.getTransaction(id) : null;
  }

  close() { this.db.close(); }
}
