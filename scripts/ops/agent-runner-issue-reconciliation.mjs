import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { linkedIssueNumberFromPr, findLinkedOpenPullRequests } from './claude-runner-review-followup.mjs';
import { STATUS_LABELS, labelNames } from './issue-metadata.mjs';

export const ISSUE_RECONCILIATION_SCHEMA_VERSION = 1;

/**
 * Bounded, deterministic failure/attention reason codes. Anything not on
 * this list is normalized to `invalid-request` by ReconciliationError, so a
 * caller can never surface a free-form string as if it were a stable code.
 */
export const RECONCILIATION_FAILURE_CODES = Object.freeze([
  'invalid-request',
  'merge-not-settled',
  'partial-github-read',
  'pr-identity-mismatch',
  'pr-not-merged',
  'head-mismatch',
  'merge-commit-mismatch',
  'base-branch-mismatch',
  'issue-linkage-ambiguous',
  'conflicting-open-pull-request',
  'issue-closed-unexpected-reason',
  'acceptance-checklist-incomplete',
  'github-write-rejected',
  'readback-verification-failed',
  'reconciliation-not-ready',
  'branch-has-later-work',
  'branch-has-open-pull-request',
  'concurrent-reconciliation-active',
  'idempotency-key-collision',
  'reconciliation-not-completable',
]);

export class ReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = RECONCILIATION_FAILURE_CODES.includes(code) ? code : 'invalid-request';
  }
}

const fail = (code, message) => { throw new ReconciliationError(code, message); };
const sha = (value) => (typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value) ? value.toLowerCase() : null);
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const UNCHECKED_TASK_ITEM = /^\s*[-*]\s*\[\s\]\s+\S/im;

const stable = (v) => (Array.isArray(v) ? v.map(stable) : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v));
const digest = (v) => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');

/**
 * Normalizes an already-completed, already-succeeded merge transaction row
 * (from `MergeTransactionStore`) into the durable identity this module
 * reconciles. This is deliberately not a free-form request shape -- the only
 * source of truth for "a merge actually happened" is the merge-transaction
 * store itself, never caller-supplied claims.
 */
export function normalizeReconciliationRequest(mergeTransaction) {
  const t = mergeTransaction;
  if (!t || typeof t !== 'object') fail('invalid-request', 'merge transaction is required');
  if (t.state !== 'completed') fail('merge-not-settled', 'merge transaction has not completed');
  if (t.settlementStatus !== 'succeeded') fail('merge-not-settled', 'post-merge settlement has not succeeded');
  const repository = repoPattern.test(t.repository || '') ? t.repository : fail('invalid-request', 'repository is invalid');
  const sourceBranch = branchPattern.test(t.sourceBranch || '') ? t.sourceBranch : fail('invalid-request', 'sourceBranch is invalid');
  const targetBranch = branchPattern.test(t.targetBranch || '') ? t.targetBranch : fail('invalid-request', 'targetBranch is invalid');
  const expectedHeadSha = sha(t.expectedHeadSha) || fail('invalid-request', 'expectedHeadSha is invalid');
  const expectedMergeCommitSha = sha(t.mergeCommitSha) || fail('invalid-request', 'mergeCommitSha is invalid');
  if (!Number.isInteger(t.issueNumber) || t.issueNumber <= 0) fail('invalid-request', 'issueNumber is invalid');
  if (!Number.isInteger(t.prNumber) || t.prNumber <= 0) fail('invalid-request', 'prNumber is invalid');
  if (typeof t.projectId !== 'string' || !t.projectId) fail('invalid-request', 'projectId is invalid');

  const identity = {
    schemaVersion: ISSUE_RECONCILIATION_SCHEMA_VERSION,
    projectId: t.projectId,
    repository,
    issueNumber: t.issueNumber,
    prNumber: t.prNumber,
    sourceBranch,
    targetBranch,
    expectedHeadSha,
    expectedMergeCommitSha,
    mergeTransactionId: t.transactionId,
  };
  const idempotencyKey = `issue-reconciliation:${digest(identity)}`;
  return Object.freeze({
    ...identity,
    idempotencyKey,
    transactionId: `issue-reconciliation-tx-${digest({ idempotencyKey }).slice(0, 48)}`,
  });
}

/** A deliberately tiny GitHub surface: issue/pull/ref reads, one issue PATCH, one ref DELETE. */
export class GhCliReconciliationClient {
  constructor({ spawn = spawnSync, env = process.env, timeoutMs = 30_000, maxOutputBytes = 1024 * 1024 } = {}) {
    this.spawn = spawn;
    this.env = Object.fromEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter((k) => env[k] != null).map((k) => [k, String(env[k])]));
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  request(method, endpoint, fields = null) {
    const allowed = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues\/\d+|pulls\/\d+|pulls\?[^#]*|git\/ref(?:s)?\/heads\/[A-Za-z0-9._/-]+)(?:\?[^#]*)?$/;
    if (!['GET', 'PATCH', 'DELETE'].includes(method) || !allowed.test(endpoint)) {
      throw new Error('GitHub API endpoint is not allowlisted');
    }
    if (method === 'DELETE' && !/\/git\/refs\/heads\/[A-Za-z0-9._/-]+$/.test(endpoint)) {
      throw new Error('GitHub API delete endpoint is not allowlisted');
    }
    if (method === 'PATCH' && !/\/issues\/\d+$/.test(endpoint)) {
      throw new Error('GitHub API patch endpoint is not allowlisted');
    }
    const args = ['api', '--method', method, endpoint];
    if (fields) args.push('--input', '-');
    const out = this.spawn('gh', args, {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: fields ? JSON.stringify(fields) : undefined, env: this.env, timeout: this.timeoutMs, maxBuffer: this.maxOutputBytes,
    });
    if (out.error?.code === 'ETIMEDOUT') { const e = new Error('GitHub request timed out'); e.code = 'provider-timeout'; throw e; }
    if (out.status !== 0) {
      if (method === 'GET' && out.status === 1 && /HTTP 404/i.test(String(out.stderr || ''))) return null;
      const e = new Error('GitHub request failed'); e.code = 'provider-request-failed'; throw e;
    }
    try { return JSON.parse(out.stdout || 'null'); } catch { const e = new Error('GitHub response is malformed'); e.code = 'provider-invalid-json'; throw e; }
  }
}

function normalizeIssue(raw, { issueNumber }) {
  if (!raw || raw.number !== issueNumber || typeof raw.state !== 'string') fail('partial-github-read', 'GitHub issue read is incomplete');
  return Object.freeze({
    number: raw.number,
    state: raw.state,
    stateReason: raw.state_reason ?? null,
    body: typeof raw.body === 'string' ? raw.body : '',
    labels: Object.freeze(labelNames(raw)),
  });
}

function normalizePr(raw, { prNumber }) {
  const headSha = sha(raw?.head?.sha);
  if (!raw || raw.number !== prNumber || typeof raw.state !== 'string' || !headSha) fail('partial-github-read', 'GitHub PR read is incomplete');
  return Object.freeze({
    number: raw.number,
    state: raw.state,
    merged: Boolean(raw.merged),
    headSha,
    headRef: typeof raw.head?.ref === 'string' ? raw.head.ref : null,
    baseRef: typeof raw.base?.ref === 'string' ? raw.base.ref : null,
    mergeCommitSha: sha(raw.merge_commit_sha),
    body: typeof raw.body === 'string' ? raw.body : '',
    title: typeof raw.title === 'string' ? raw.title : '',
  });
}

/** Bounded (max 3 pages of 100) list of open pull requests for the repository, used only for ambiguity/conflict detection. */
function listOpenPullRequests(client, repository) {
  const items = [];
  for (let page = 1; page <= 3; page += 1) {
    const raw = client.request('GET', `/repos/${repository}/pulls?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(raw)) fail('partial-github-read', 'GitHub open pull request read is malformed');
    items.push(...raw);
    if (raw.length < 100) break;
  }
  return Object.freeze(items.map((pr) => ({ number: pr.number, body: pr.body, title: pr.title, headRefName: pr.head?.ref })));
}

/** Re-reads issue, PR, target-branch source-branch ref and open PRs immediately before every decision. */
export function readReconciliationEvidence({ client, request }) {
  if (!client || typeof client.request !== 'function') fail('partial-github-read', 'GitHub client is required');
  const repo = request.repository;
  const rawIssue = client.request('GET', `/repos/${repo}/issues/${request.issueNumber}`);
  const rawPr = client.request('GET', `/repos/${repo}/pulls/${request.prNumber}`);
  const rawBranchRef = client.request('GET', `/repos/${repo}/git/ref/heads/${request.sourceBranch}`);
  const openPrs = listOpenPullRequests(client, repo);
  const issue = normalizeIssue(rawIssue, { issueNumber: request.issueNumber });
  const pr = normalizePr(rawPr, { prNumber: request.prNumber });
  const branchHeadSha = rawBranchRef === null ? null : sha(rawBranchRef?.object?.sha);
  if (rawBranchRef !== null && !branchHeadSha) fail('partial-github-read', 'GitHub branch ref read is malformed');
  return Object.freeze({ issue, pr, branchHeadSha, openPrs });
}

function alreadyReconciled(issue, request) {
  return issue.state === 'closed' && issue.stateReason === 'completed'
    && issue.labels.includes('status:done');
}

/**
 * Pure, default-deny reconciliation-eligibility decision. Never mutates.
 * `alreadyDone` distinguishes "this issue was already reconciled by this
 * exact transaction identity" (idempotent adoption, no further writes
 * needed) from "eligible, needs writes".
 */
export function evaluateIssueReconciliationEligibility(evidence, request) {
  const { issue, pr, openPrs } = evidence;
  if (pr.number !== request.prNumber) return Object.freeze({ eligible: false, reasonCode: 'pr-identity-mismatch' });
  if (!pr.merged) return Object.freeze({ eligible: false, reasonCode: 'pr-not-merged' });
  if (pr.headSha !== request.expectedHeadSha) return Object.freeze({ eligible: false, reasonCode: 'head-mismatch' });
  if (pr.mergeCommitSha !== request.expectedMergeCommitSha) return Object.freeze({ eligible: false, reasonCode: 'merge-commit-mismatch' });
  if (pr.baseRef !== request.targetBranch) return Object.freeze({ eligible: false, reasonCode: 'base-branch-mismatch' });

  const linked = linkedIssueNumberFromPr({ body: pr.body, title: pr.title });
  const branchNamedForIssue = new RegExp(`(^|[-/])${request.issueNumber}$`).test(pr.headRef || '');
  if (linked !== request.issueNumber && !branchNamedForIssue) {
    return Object.freeze({ eligible: false, reasonCode: 'issue-linkage-ambiguous' });
  }

  const conflicting = findLinkedOpenPullRequests({ issueNumber: request.issueNumber, pullRequests: openPrs })
    .filter((candidate) => candidate.number !== request.prNumber);
  if (conflicting.length > 0) return Object.freeze({ eligible: false, reasonCode: 'conflicting-open-pull-request' });

  if (issue.state === 'closed') {
    if (alreadyReconciled(issue, request)) return Object.freeze({ eligible: true, reasonCode: null, alreadyDone: true });
    return Object.freeze({ eligible: false, reasonCode: 'issue-closed-unexpected-reason' });
  }

  if (UNCHECKED_TASK_ITEM.test(issue.body)) {
    return Object.freeze({ eligible: false, reasonCode: 'acceptance-checklist-incomplete' });
  }

  return Object.freeze({ eligible: true, reasonCode: null, alreadyDone: false });
}

function reconciledLabels(existingLabels) {
  const kept = existingLabels.filter((label) => !Object.hasOwn(STATUS_LABELS, label));
  return [...new Set([...kept, 'status:done'])];
}

/**
 * At most one durable reconciliation per merge-transaction identity,
 * restart-safe. Replaying a `completed` identity performs no GitHub calls.
 * Resuming an `issue_closed` identity (a crash between GitHub confirming the
 * close and this store recording it) never re-issues the PATCH -- it only
 * reads back and completes.
 */
export async function reconcileMergedIssue({ request, store, client, now = new Date().toISOString() } = {}) {
  if (!store || typeof store.beginReconciliation !== 'function') fail('invalid-request', 'reconciliation store is required');
  const begun = store.beginReconciliation(request, { now });
  if (begun.reconciliation.state === 'completed') return Object.freeze({ ...begun.reconciliation.result, replayed: true });

  // A prior `attention` refusal is not a point of no return -- no GitHub
  // mutation happened yet -- so every retry (including a replay of an
  // attention identity) re-reads live evidence and re-evaluates fresh,
  // rather than trusting a stale refusal that may no longer hold.
  if (begun.reconciliation.state !== 'issue_closed') {
    let before;
    try {
      before = readReconciliationEvidence({ client, request });
    } catch (error) {
      const code = error instanceof ReconciliationError ? error.code : 'partial-github-read';
      store.attentionReconciliation(request.transactionId, { reasonCode: code, now });
      throw error;
    }
    const eligibility = evaluateIssueReconciliationEligibility(before, request);
    if (!eligibility.eligible) {
      store.attentionReconciliation(request.transactionId, { reasonCode: eligibility.reasonCode, before, now });
      fail(eligibility.reasonCode, 'issue is not eligible for reconciliation');
    }

    const intended = { labels: reconciledLabels(before.issue.labels), state: 'closed', stateReason: 'completed' };
    if (!eligibility.alreadyDone) {
      try {
        client.request('PATCH', `/repos/${request.repository}/issues/${request.issueNumber}`, { labels: intended.labels });
        client.request('PATCH', `/repos/${request.repository}/issues/${request.issueNumber}`, { state: 'closed', state_reason: 'completed' });
      } catch (error) {
        store.attentionReconciliation(request.transactionId, { reasonCode: 'github-write-rejected', before, now });
        throw error;
      }
    }
    const recorded = store.recordIssueClosed(request.transactionId, { before, intended, now });
    if (!recorded) fail('github-write-rejected', 'unable to record reconciliation state');
  }

  const rawReadback = client.request('GET', `/repos/${request.repository}/issues/${request.issueNumber}`);
  const readbackIssue = normalizeIssue(rawReadback, { issueNumber: request.issueNumber });
  if (readbackIssue.state !== 'closed' || readbackIssue.stateReason !== 'completed' || !readbackIssue.labels.includes('status:done')) {
    fail('readback-verification-failed', 'GitHub read-back did not confirm reconciliation');
  }
  const result = Object.freeze({
    schemaVersion: ISSUE_RECONCILIATION_SCHEMA_VERSION, transactionId: request.transactionId,
    issueNumber: request.issueNumber, closed: true, statusLabel: 'status:done',
  });
  store.completeReconciliation(request.transactionId, { result, readback: { issue: readbackIssue }, now });
  return { ...result, replayed: false };
}

/**
 * Deletes only the exact merged remote branch, and only after this exact
 * transaction's issue reconciliation has already completed. Re-reads the
 * live branch ref and open-PR state immediately before deleting; a branch
 * that has moved (later unmerged work) or still backs an open PR is refused,
 * never force-deleted.
 */
export async function deleteMergedRemoteBranch({ request, store, client, now = new Date().toISOString() } = {}) {
  if (!store || typeof store.getTransaction !== 'function') fail('invalid-request', 'reconciliation store is required');
  const existing = store.getTransaction(request.transactionId);
  if (!existing || existing.state !== 'completed') fail('reconciliation-not-ready', 'issue reconciliation has not completed');
  if (existing.remoteBranchState === 'deleted') return Object.freeze({ transactionId: request.transactionId, branch: request.sourceBranch, deleted: true, replayed: true });
  // A prior `attention` refusal here is likewise not a point of no return --
  // re-read live evidence and re-evaluate rather than trusting a stale code.

  const rawRef = client.request('GET', `/repos/${request.repository}/git/ref/heads/${request.sourceBranch}`);
  const currentSha = rawRef === null ? null : sha(rawRef?.object?.sha);
  if (rawRef !== null && !currentSha) fail('partial-github-read', 'GitHub branch ref read is malformed');

  if (currentSha === null) {
    // Already gone: adopt rather than fail, so a replay after a prior
    // out-of-band or previously-successful delete stays idempotent.
    store.recordRemoteBranchDeleted(request.transactionId, { before: { branchHeadSha: null }, readback: { branchHeadSha: null }, now });
    return Object.freeze({ transactionId: request.transactionId, branch: request.sourceBranch, deleted: true, replayed: false, alreadyAbsent: true });
  }
  if (currentSha !== request.expectedHeadSha) {
    store.attentionRemoteBranch(request.transactionId, { reasonCode: 'branch-has-later-work', now });
    fail('branch-has-later-work', 'remote branch head has advanced past the merged commit');
  }
  const openPrs = listOpenPullRequests(client, request.repository);
  if (openPrs.some((pr) => pr.headRefName === request.sourceBranch)) {
    store.attentionRemoteBranch(request.transactionId, { reasonCode: 'branch-has-open-pull-request', now });
    fail('branch-has-open-pull-request', 'remote branch still backs an open pull request');
  }

  try {
    client.request('DELETE', `/repos/${request.repository}/git/refs/heads/${request.sourceBranch}`);
  } catch (error) {
    store.attentionRemoteBranch(request.transactionId, { reasonCode: 'github-write-rejected', now });
    throw error;
  }
  const readbackRef = client.request('GET', `/repos/${request.repository}/git/ref/heads/${request.sourceBranch}`);
  if (readbackRef !== null) fail('readback-verification-failed', 'GitHub read-back did not confirm branch deletion');

  store.recordRemoteBranchDeleted(request.transactionId, { before: { branchHeadSha: currentSha }, readback: { branchHeadSha: null }, now });
  return Object.freeze({ transactionId: request.transactionId, branch: request.sourceBranch, deleted: true, replayed: false });
}
