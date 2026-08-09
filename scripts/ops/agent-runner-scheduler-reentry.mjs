#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// #157: closes the one remaining gap between #156 (post-merge issue
// reconciliation) and #113/#50-style automated selection -- a durable,
// restart-safe marker that control has returned to queue inspection after a
// reconciliation transaction reaches 'completed', plus one bounded
// next-candidate selection pass built entirely from the already-existing,
// already-tested selection contract (`selectIssue`/`claude-runner-candidate-probe.mjs`).
// This module never claims an issue, never launches a worker, never calls a
// model and never writes to GitHub -- it only records durable evidence and
// classifies whatever a caller-supplied selection function returns.

export const SCHEDULER_REENTRY_SCHEMA_VERSION = 1;
export const SCHEDULER_REENTRY_ACTIONS = Object.freeze([
  'pending', 'idle', 'candidate_selected', 'skip_and_continue',
]);

const parse = (r) => r && Object.freeze({
  reconciliationTransactionId: r.reconciliation_transaction_id,
  repository: r.repository,
  issueNumber: r.issue_number,
  projectId: r.project_id,
  nextAction: r.next_action,
  selectedIssueNumber: r.selected_issue_number,
  skippedCount: r.skipped_count,
  emittedAt: r.emitted_at,
  resolvedAt: r.resolved_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Durable, restart-safe record of one scheduler-reentry event, one row per
 * completed `IssueReconciliationStore` transaction identity. States:
 * `pending` (emitted, next-candidate selection not yet recorded) ->
 * `idle` | `candidate_selected` | `skip_and_continue` (terminal). Replaying
 * an already-emitted transaction id is always a no-op read, never a second
 * insert or update.
 */
export class SchedulerReentryStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (!dbPath) throw new Error('scheduler reentry db path is required');
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS scheduler_reentry_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduler_reentry_events(
        reconciliation_transaction_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        project_id TEXT,
        next_action TEXT NOT NULL CHECK(next_action IN ('pending','idle','candidate_selected','skip_and_continue')),
        selected_issue_number INTEGER,
        skipped_count INTEGER,
        emitted_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO scheduler_reentry_schema VALUES(?,?)').run(SCHEDULER_REENTRY_SCHEMA_VERSION, this.now());
  }

  getEvent(transactionId) {
    return parse(this.db.prepare('SELECT * FROM scheduler_reentry_events WHERE reconciliation_transaction_id=?').get(transactionId));
  }

  /** Idempotent: replaying an already-emitted reconciliation transaction id returns the existing row untouched. */
  emitPending(transactionId, { repository, issueNumber, projectId = null, now = this.now() } = {}) {
    const existing = this.getEvent(transactionId);
    if (existing) return existing;
    this.db.prepare(`
      INSERT INTO scheduler_reentry_events(
        reconciliation_transaction_id, repository, issue_number, project_id,
        next_action, selected_issue_number, skipped_count, emitted_at, resolved_at, created_at, updated_at
      ) VALUES (?,?,?,?, 'pending', NULL, NULL, ?, NULL, ?, ?)
    `).run(transactionId, repository, issueNumber, projectId, now, now, now);
    return this.getEvent(transactionId);
  }

  /** Idempotent: only a row still `pending` transitions; an already-resolved row is returned unchanged. */
  recordSelectionOutcome(transactionId, { nextAction, selectedIssueNumber = null, skippedCount = 0, now = this.now() } = {}) {
    if (!SCHEDULER_REENTRY_ACTIONS.includes(nextAction) || nextAction === 'pending') {
      throw new Error('scheduler reentry next action is invalid');
    }
    this.db.prepare(`
      UPDATE scheduler_reentry_events
      SET next_action=?, selected_issue_number=?, skipped_count=?, resolved_at=?, updated_at=?
      WHERE reconciliation_transaction_id=? AND next_action='pending'
    `).run(nextAction, selectedIssueNumber, skippedCount, now, now, transactionId);
    return this.getEvent(transactionId);
  }

  close() { this.db.close(); }
}

/**
 * Fail-closed emission: a scheduler-reentry event may only be recorded for a
 * reconciliation transaction that has actually reached `completed` in the
 * sole evidence source, `IssueReconciliationStore` (#156). A missing or
 * non-terminal transaction refuses with a closed reason code rather than
 * emitting speculative evidence. Replaying an already-emitted transaction id
 * never re-reads the reconciliation store.
 */
export function emitSchedulerReentryEvent({
  reconciliationStore, reentryStore, transactionId, now = new Date().toISOString(),
} = {}) {
  if (!reconciliationStore || typeof reconciliationStore.getTransaction !== 'function') {
    throw new Error('issue reconciliation store is required');
  }
  if (!reentryStore || typeof reentryStore.emitPending !== 'function') {
    throw new Error('scheduler reentry store is required');
  }
  if (typeof transactionId !== 'string' || !transactionId) {
    throw Object.assign(new Error('reconciliation transaction id is required'), { code: 'invalid-request' });
  }
  const existing = reentryStore.getEvent(transactionId);
  if (existing) return existing;
  const reconciliation = reconciliationStore.getTransaction(transactionId);
  if (!reconciliation) {
    throw Object.assign(new Error('reconciliation transaction not found'), { code: 'reconciliation-transaction-not-found' });
  }
  if (reconciliation.state !== 'completed') {
    throw Object.assign(new Error('reconciliation transaction has not reached completed'), { code: 'reconciliation-not-completed' });
  }
  return reentryStore.emitPending(transactionId, {
    repository: reconciliation.repository,
    issueNumber: reconciliation.issueNumber,
    projectId: reconciliation.projectId,
    now,
  });
}

/**
 * Pure classification of one production `claude-runner-cron.mjs` `main()`
 * pass's own final durable-result payload (#157) into the `{ issue, skipped }`
 * shape `classifySchedulerReentrySelection` expects. `payload.claim` is
 * `main()`'s own atomic signal that `claimIssueForExecution` actually ran
 * this pass -- set only on a genuine fresh (non-recovery) claim, `null` on
 * every dry-run, quota-blocked, no-selection, or candidate-specific-blocker
 * (dispatch-authority-rejected, model-resolution-invalid, workspace-
 * ownership-conflict, settings-revision-changed) outcome. Using it (rather
 * than the mere presence of `selectedIssue`) means a candidate that was
 * inspected but never actually claimed/launched is classified `idle`, never
 * misreported as `candidate_selected`. A due-recovery re-invocation (which
 * never sets `claim`) is a known, documented under-count here: it is a rare
 * concurrent-due-recovery edge case, not the primary reconciliation-to-
 * reentry path, and under-counting it is safe (never a duplicate claim,
 * never spins) even though it does not credit the recovery launch that
 * actually happened.
 */
export function classifyProductionHandoffResult(payload = {}) {
  const claimed = Boolean(payload && payload.claim) && typeof payload.selectedIssue === 'number';
  return {
    issue: claimed ? { number: payload.selectedIssue } : null,
    skipped: Array.isArray(payload?.skipped) ? payload.skipped : [],
  };
}

/**
 * Pure classification of whatever the injected selection function returns.
 * The expected shape is exactly `selectIssue()`'s result (also consumed by
 * `claude-runner-candidate-probe.mjs`): `{ issue, skipped }`. A first
 * candidate that required skipping others is reported as
 * `skip_and_continue` rather than a plain `candidate_selected`, so bounded
 * skip evidence is always distinguishable from a clean first-candidate pick.
 */
export function classifySchedulerReentrySelection(selected = {}) {
  const skippedCount = Array.isArray(selected?.skipped) ? selected.skipped.length : 0;
  if (selected?.issue) {
    return {
      nextAction: skippedCount > 0 ? 'skip_and_continue' : 'candidate_selected',
      selectedIssueNumber: selected.issue.number,
      skippedCount,
    };
  }
  return { nextAction: 'idle', selectedIssueNumber: null, skippedCount };
}

/**
 * The scheduler re-entry step (#157): emit durable reentry evidence for a
 * completed reconciliation transaction, then -- strictly after that
 * emission, so the live GitHub read this triggers always follows the
 * reconciliation's own settled write -- run exactly one bounded
 * next-candidate selection pass through the caller-supplied
 * `selectNextCandidate`. Replaying an already-resolved transaction performs
 * neither a reconciliation-store read nor a selection pass. This function
 * introduces no claim, worker launch, model call or GitHub write of its own;
 * it only sequences and durably records what the injected selection
 * function reports.
 */
export async function runSchedulerReentryCycle({
  reconciliationStore, reentryStore, transactionId, selectNextCandidate, now = new Date().toISOString(),
} = {}) {
  const event = emitSchedulerReentryEvent({ reconciliationStore, reentryStore, transactionId, now });
  if (event.nextAction !== 'pending') {
    return { ...event, replayed: true };
  }
  if (typeof selectNextCandidate !== 'function') throw new Error('selectNextCandidate is required');
  const selected = await selectNextCandidate();
  const outcome = classifySchedulerReentrySelection(selected);
  const recorded = reentryStore.recordSelectionOutcome(transactionId, { ...outcome, now });
  return { ...recorded, replayed: false };
}
