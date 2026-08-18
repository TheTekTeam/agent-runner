import { GhCliReconciliationClient } from './agent-runner-issue-reconciliation.mjs';

export const ATTENTION_RECONCILIATION_SCHEMA_VERSION = 1;

/** Bounded, deterministic vocabulary. `unknown` fails closed and is never treated as resolved/healthy. */
export const ATTENTION_RECONCILIATION_STATUSES = Object.freeze(['actionable', 'historical', 'unknown']);

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Pure classification of one already-fetched GitHub issue read against the
 * bounded reconciliation vocabulary. An open issue is `actionable` by
 * default (fail closed: absence of proof it is closed is not proof it is
 * done), and a closed issue is `historical` regardless of its specific
 * close reason, since #183 explicitly requires closed/completed/not-planned/
 * duplicate items to stop inflating the current operator-action count and
 * defines no bounded rule under which a closed issue still requires action.
 */
export function classifyGithubIssueState(issue) {
  if (!issue || typeof issue !== 'object' || typeof issue.state !== 'string') {
    return Object.freeze({ status: 'unknown', reasonCode: 'issue-not-found' });
  }
  if (issue.state === 'closed') {
    const reason = typeof issue.state_reason === 'string' && issue.state_reason ? issue.state_reason : 'unspecified';
    return Object.freeze({ status: 'historical', reasonCode: `closed-${reason}` });
  }
  if (issue.state === 'open') {
    return Object.freeze({ status: 'actionable', reasonCode: 'issue-open' });
  }
  return Object.freeze({ status: 'unknown', reasonCode: 'issue-state-unrecognized' });
}

/**
 * Repository-qualified, read-only reconciliation of a single attention
 * record's GitHub identity. Never mutates GitHub. Any lookup failure
 * (network, malformed response, rate limit, ambiguous read) fails closed to
 * `unknown` -- it is never promoted to `historical`.
 */
export function reconcileAttentionIdentity({ repository, issueNumber, client }) {
  if (!repoPattern.test(repository || '')) {
    return Object.freeze({ repository, issueNumber, status: 'unknown', reasonCode: 'invalid-repository', githubState: null, githubStateReason: null });
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return Object.freeze({ repository, issueNumber, status: 'unknown', reasonCode: 'invalid-issue-number', githubState: null, githubStateReason: null });
  }
  let raw;
  try {
    raw = client.request('GET', `/repos/${repository}/issues/${issueNumber}`);
  } catch {
    return Object.freeze({ repository, issueNumber, status: 'unknown', reasonCode: 'lookup-unavailable', githubState: null, githubStateReason: null });
  }
  if (raw && raw.number !== issueNumber) {
    return Object.freeze({ repository, issueNumber, status: 'unknown', reasonCode: 'lookup-ambiguous', githubState: null, githubStateReason: null });
  }
  const { status, reasonCode } = classifyGithubIssueState(raw);
  return Object.freeze({
    repository,
    issueNumber,
    status,
    reasonCode,
    githubState: raw?.state ?? null,
    githubStateReason: raw?.state_reason ?? null,
  });
}

/**
 * Deduplicates a bounded list of `attention_events` rows down to distinct,
 * repository-qualified (repository, issueNumber) identities -- reconciliation
 * is never performed by issue number alone, and never against an already
 * internally-resolved attention row.
 */
export function distinctUnresolvedAttentionIdentities(attentionEvents = []) {
  const seen = new Map();
  for (const row of attentionEvents) {
    if (row?.resolved_at) continue;
    const repository = row?.repo;
    const issueNumber = row?.issue_number;
    if (typeof repository !== 'string' || !repository || !Number.isInteger(issueNumber)) continue;
    seen.set(`${repository} ${issueNumber}`, { repository, issueNumber });
  }
  return [...seen.values()];
}

/**
 * Reconciles every distinct unresolved (repository, issueNumber) identity in
 * `attentionEvents` against live GitHub state and durably records each
 * decision in `store` -- idempotent (re-running against unchanged GitHub
 * state re-verifies and re-records the same decision) and never deletes
 * prior evidence in `attentionEvents` itself, which this function never
 * touches.
 */
export function reconcileAttentionEvents({ attentionEvents = [], store, client = new GhCliReconciliationClient(), now = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.upsert !== 'function') throw new Error('reconciliation store is required');
  const identities = distinctUnresolvedAttentionIdentities(attentionEvents);
  const results = [];
  for (const identity of identities) {
    const decision = reconcileAttentionIdentity({ ...identity, client });
    const recorded = store.upsert({
      repository: decision.repository,
      issueNumber: decision.issueNumber,
      status: decision.status,
      reasonCode: decision.reasonCode,
      githubState: decision.githubState,
      githubStateReason: decision.githubStateReason,
      evidence: { githubState: decision.githubState, githubStateReason: decision.githubStateReason },
      now: now(),
    });
    results.push(recorded);
  }
  return results;
}

/**
 * Builds a "repository issueNumber" -> reconciliation row lookup map for the
 * canonical status-projection layer (buildRunnerOperatorStatus()) to
 * consume, shared identically by the standalone dashboard, the CLI and any
 * future read-only exporter. Accepts either a store (with
 * listForRepository()) or an already-fetched array of reconciliation rows.
 */
export function attentionReconciliationLookup(storeOrRows, repository) {
  const rows = Array.isArray(storeOrRows)
    ? storeOrRows
    : (storeOrRows && typeof storeOrRows.listForRepository === 'function' ? storeOrRows.listForRepository(repository) : []);
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.repository} ${row.issueNumber}`, row);
  }
  return map;
}

/**
 * Effective reconciliation status for one attention_events row, honoring an
 * explicit operator acknowledgement over the automatic decision when
 * present. Returns null (no opinion -- still counted as unresolved by the
 * caller) when no reconciliation has ever been recorded for this identity,
 * so a fresh unresolved attention record is never silently treated as
 * historical before it has actually been reconciled.
 */
export function effectiveAttentionReconciliationStatus(row, reconciliationsByIdentity) {
  if (!reconciliationsByIdentity || typeof row?.repo !== 'string' || !Number.isInteger(row?.issue_number)) return null;
  const record = reconciliationsByIdentity.get(`${row.repo} ${row.issue_number}`);
  if (!record) return null;
  if (record.acknowledgedStatus) return record.acknowledgedStatus;
  return record.status;
}
