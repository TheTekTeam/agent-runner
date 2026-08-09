import { spawnSync } from 'node:child_process';
import { evaluateValidationFreshness } from './agent-runner-validation-profile-contract.mjs';
import { collectGitHubCheckSnapshot } from './agent-runner-github-checks-provider.mjs';
import {
  MergePolicyError, evaluateMergeEligibility, mapValidationFreshnessFailure,
} from './agent-runner-merge-policy.mjs';

const sha = (value) => (typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value) ? value.toLowerCase() : null);
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const fail = (code, message) => { throw new MergePolicyError(code, message); };

/** A deliberately tiny GitHub surface: PR/reviews/base-ref GET plus one merge PUT. */
export class GhCliMergeClient {
  constructor({ spawn = spawnSync, env = process.env, timeoutMs = 30_000, maxOutputBytes = 1024 * 1024 } = {}) {
    this.spawn = spawn;
    this.env = Object.fromEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter((k) => env[k] != null).map((k) => [k, String(env[k])]));
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  request(method, endpoint, fields = null) {
    const allowed = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues\/\d+\/comments|pulls\/\d+(?:\/(?:reviews|merge))?|git\/ref\/heads\/.+)(?:\?[^#]*)?$/;
    if (!['GET', 'PUT'].includes(method) || !allowed.test(endpoint) || (method === 'PUT' && !/\/pulls\/\d+\/merge(?:\?.*)?$/.test(endpoint))) {
      throw new Error('GitHub API endpoint is not allowlisted');
    }
    const args = ['api', '--method', method, endpoint];
    if (fields) for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`);
    const out = this.spawn('gh', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: this.env, timeout: this.timeoutMs, maxBuffer: this.maxOutputBytes,
    });
    if (out.error?.code === 'ETIMEDOUT') { const e = new Error('GitHub request timed out'); e.code = 'provider-timeout'; throw e; }
    if (out.status !== 0) { const e = new Error('GitHub request failed'); e.code = 'provider-request-failed'; throw e; }
    try { return JSON.parse(out.stdout || 'null'); } catch { const e = new Error('GitHub response is malformed'); e.code = 'provider-invalid-json'; throw e; }
  }
}

function latestReviewStatePerAuthor(reviews) {
  const byAuthor = new Map();
  for (const review of reviews) {
    const author = review?.user?.login;
    if (typeof author !== 'string' || !author) continue;
    const submittedAt = review?.submitted_at || '1970-01-01T00:00:00Z';
    const existing = byAuthor.get(author);
    if (!existing || Date.parse(submittedAt) >= Date.parse(existing.submittedAt)) {
      byAuthor.set(author, { author, state: String(review?.state || '').toUpperCase(), submittedAt });
    }
  }
  return [...byAuthor.values()];
}

/** Pure review-settlement decision: no pending requests, no outstanding change requests, enough approvals. */
export function settleReviews({ reviews = [], requestedReviewersCount = 0, requiredApprovals = 0 }) {
  if (requiredApprovals <= 0) return Object.freeze({ settled: true, reasonCode: null, approvals: 0 });
  const latest = latestReviewStatePerAuthor(reviews);
  const changesRequested = latest.filter((r) => r.state === 'CHANGES_REQUESTED').length;
  const approvals = latest.filter((r) => r.state === 'APPROVED').length;
  if (changesRequested > 0 || requestedReviewersCount > 0 || approvals < requiredApprovals) {
    return Object.freeze({ settled: false, reasonCode: 'review-required', approvals });
  }
  return Object.freeze({ settled: true, reasonCode: null, approvals });
}

function normalizePr(raw, { prNumber }) {
  const headSha = sha(raw?.head?.sha);
  const baseSha = sha(raw?.base?.sha);
  if (!raw || raw.number !== prNumber || typeof raw.state !== 'string' || !headSha || !baseSha) {
    fail('partial-github-read', 'GitHub PR read is incomplete');
  }
  return Object.freeze({
    number: raw.number,
    state: raw.state,
    draft: Boolean(raw.draft),
    merged: Boolean(raw.merged),
    mergeable: raw.mergeable === true ? true : (raw.mergeable === false ? false : null),
    mergeableState: typeof raw.mergeable_state === 'string' ? raw.mergeable_state : 'unknown',
    headSha,
    baseSha,
    headRef: typeof raw.head?.ref === 'string' ? raw.head.ref : null,
    baseRef: typeof raw.base?.ref === 'string' ? raw.base.ref : null,
    mergeCommitSha: sha(raw.merge_commit_sha),
    requestedReviewersCount: (Array.isArray(raw.requested_reviewers) ? raw.requested_reviewers.length : 0)
      + (Array.isArray(raw.requested_teams) ? raw.requested_teams.length : 0),
  });
}

/**
 * Immediately re-reads PR, reviews and the live target-branch head. This is
 * the single evidence surface both the pre-mutation gate and the
 * immediately-before-mutation re-check share, so drift detection compares
 * like-for-like reads.
 */
export async function readMergeEvidence({ client, checksClient, request, includeChecks = true }) {
  if (!client || typeof client.request !== 'function') fail('partial-github-read', 'GitHub client is required');
  const repo = repoPattern.test(request.repository) ? request.repository : fail('repository-mismatch', 'invalid repository');
  let raw;
  let reviews;
  let baseRef;
  try {
    [raw, reviews, baseRef] = await Promise.all([
      client.request('GET', `/repos/${repo}/pulls/${request.prNumber}`),
      client.request('GET', `/repos/${repo}/pulls/${request.prNumber}/reviews?per_page=100`),
      client.request('GET', `/repos/${repo}/git/ref/heads/${request.targetBranch}`),
    ]);
  } catch (error) {
    if (error instanceof MergePolicyError) throw error;
    fail('partial-github-read', 'GitHub read was ambiguous');
  }
  const pr = normalizePr(raw, { prNumber: request.prNumber });
  const baseHeadSha = sha(baseRef?.object?.sha);
  if (!Array.isArray(reviews) || !baseHeadSha) fail('partial-github-read', 'GitHub PR read is malformed');
  let checks = null;
  if (includeChecks && !pr.merged) {
    if (!checksClient || typeof checksClient.requestJson !== 'function') fail('partial-github-read', 'checks client is required');
    try {
      const collected = await collectGitHubCheckSnapshot({ repository: repo, sha: pr.headSha, requestJson: checksClient.requestJson.bind(checksClient) });
      checks = collected.snapshot;
    } catch {
      fail('settlement-read-incomplete', 'check settlement read is incomplete');
    }
  }
  return Object.freeze({ pr, reviews: Object.freeze(reviews), baseHeadSha, checks });
}

function assertPreMergeState(evidence, request) {
  const { pr } = evidence;
  if (pr.headSha !== request.expectedHeadSha) fail('head-changed', 'pull request head changed');
  if (pr.baseSha !== request.expectedBaseSha || evidence.baseHeadSha !== request.expectedBaseSha) fail('base-changed', 'target branch head changed');
  if (pr.state !== 'open') fail('pr-not-open', 'pull request is not open');
  if (pr.draft) fail('pr-draft', 'pull request is a draft');
  if (!evidence.checks || evidence.checks.queryComplete !== true || !evidence.checks.checks.every((c) => c.terminal)) fail('checks-unsettled', 'checks are not settled');
  const failed = evidence.checks.checks.filter((c) => c.conclusion && !['success', 'neutral', 'skipped'].includes(c.conclusion));
  if (failed.length > 0) fail('checks-failed', 'checks did not succeed');
  const review = settleReviews({ reviews: evidence.reviews, requestedReviewersCount: pr.requestedReviewersCount, requiredApprovals: request.requiredApprovals });
  if (!review.settled) fail('review-required', 'required reviews are not settled');
  if (pr.mergeable === false || pr.mergeableState === 'dirty') fail('merge-conflict', 'pull request has a merge conflict');
  if (pr.mergeable !== true || pr.mergeableState !== 'clean') fail('not-mergeable', 'pull request mergeability is not confirmed clean');
}

/**
 * At most one durable merge transaction, exact-head protected and
 * restart-safe. On replay of a `completed` identity this performs no
 * GitHub calls at all. On resume of a `github_merged` identity (a crash
 * between GitHub confirming the merge and this store recording it) this
 * never re-attempts the PUT -- it only reads back and completes. A fresh
 * `pending` row is checked against live PR state before ever calling PUT,
 * so an already-merged PR (crash after PUT succeeded, before recording) is
 * adopted instead of merged twice.
 */
export async function executeMergeTransaction({
  request, store, client, checksClient, evidenceStore, profileContracts, authorityCheck, now = new Date().toISOString(),
} = {}) {
  if (!store || typeof store.beginTransaction !== 'function') fail('invalid-request', 'merge transaction store is required');
  if (typeof authorityCheck !== 'function') fail('manager-authority-missing', 'authority check is required');
  const begun = store.beginTransaction(request, { now });
  if (begun.transaction.state === 'completed') return Object.freeze({ ...begun.transaction.result, replayed: true });

  if (begun.transaction.state !== 'github_merged') {
    try {
      const eligibility = evaluateMergeEligibility(request);
      if (!eligibility.eligible) fail(eligibility.reasonCode, 'merge request is not eligible for automatic merge');

      for (const needed of request.requiredValidationProfiles) {
        const evidence = evidenceStore?.get?.(needed.validationId);
        if (!evidence) fail('validation-evidence-missing', 'validation evidence is missing');
        const freshness = evaluateValidationFreshness(evidence, {
          projectId: request.projectId, profile: needed.profile, expectedSha: request.expectedHeadSha,
          currentProfileContractSha256: profileContracts?.[needed.profile], now,
        });
        if (!freshness.fresh) fail(mapValidationFreshnessFailure(freshness.reason), 'validation evidence is not fresh');
      }

      const before = await readMergeEvidence({ client, checksClient, request });
      if (before.pr.merged) {
        if (before.pr.headSha !== request.expectedHeadSha) fail('unexpected-merge-state', 'pull request is already merged with an unexpected head');
      } else {
        assertPreMergeState(before, request);
      }
      if (!await authorityCheck(request)) fail('manager-authority-stale', 'manager authority is stale');

      let mergeCommitSha = before.pr.mergeCommitSha;
      if (!before.pr.merged) {
        // Immediately before mutation: re-read once more so the final decision uses the freshest possible evidence.
        const current = await readMergeEvidence({ client, checksClient, request });
        if (current.pr.merged) {
          if (current.pr.headSha !== request.expectedHeadSha) fail('unexpected-merge-state', 'pull request is already merged with an unexpected head');
        } else {
          assertPreMergeState(current, request);
          if (!await authorityCheck(request)) fail('manager-authority-stale', 'manager authority is stale');
          let response;
          try {
            response = client.request('PUT', `/repos/${request.repository}/pulls/${request.prNumber}/merge`, {
              sha: request.expectedHeadSha, merge_method: request.mergeMethod,
            });
          } catch {
            response = null;
          }
          if (response && response.merged === true) {
            mergeCommitSha = sha(response.sha) || mergeCommitSha;
          } else {
            // The PUT failed or returned an unexpected body. Re-read once to distinguish an
            // actual merge that raced our own call from a genuine failure, rather than guessing
            // from error text -- GitHub's merge endpoint is the only source of truth here.
            const recheck = await readMergeEvidence({ client, checksClient, request, includeChecks: false });
            if (recheck.pr.merged && recheck.pr.headSha === request.expectedHeadSha) {
              mergeCommitSha = recheck.pr.mergeCommitSha || mergeCommitSha;
            } else {
              fail('github-write-rejected', 'GitHub did not confirm the merge');
            }
          }
        }
      }
      const recorded = store.recordGithubMerged(request.transactionId, {
        before, intended: { headSha: request.expectedHeadSha, baseSha: request.expectedBaseSha, mergeMethod: request.mergeMethod }, mergeCommitSha, now,
      });
      if (!recorded) fail('github-write-rejected', 'unable to record merge transaction state');
    } catch (error) {
      const code = error instanceof MergePolicyError ? error.code : 'github-write-rejected';
      store.failTransaction(request.transactionId, { errorCode: code, result: { reasonCode: code }, now });
      throw error;
    }
  }

  const merged = store.getTransaction(request.transactionId);
  const after = await readMergeEvidence({ client, checksClient, request, includeChecks: false });
  if (!after.pr.merged || after.pr.headSha !== request.expectedHeadSha) {
    fail('github-write-rejected', 'GitHub read-back did not confirm the merge');
  }
  const result = Object.freeze({
    schemaVersion: 1, transactionId: request.transactionId, prNumber: request.prNumber,
    mergeCommitSha: merged.mergeCommitSha, headSha: request.expectedHeadSha,
  });
  store.completeTransaction(request.transactionId, { result, readback: { headSha: after.pr.headSha, merged: after.pr.merged, mergeCommitSha: after.pr.mergeCommitSha }, now });
  return { ...result, replayed: false };
}

/** Bounded, generic classification of an already-normalized post-merge check snapshot. */
export function classifyPostMergeSettlement(snapshot) {
  if (!snapshot?.checks) return Object.freeze({ status: 'pending', reasonCode: 'no-check-snapshot' });
  if (snapshot.checks.length === 0) return Object.freeze({ status: 'pending', reasonCode: 'no-checks-reported' });
  if (!snapshot.checks.every((c) => c.terminal)) return Object.freeze({ status: 'pending', reasonCode: 'checks-in-progress' });
  const failed = snapshot.checks.filter((c) => c.conclusion && !['success', 'neutral', 'skipped'].includes(c.conclusion));
  if (failed.length > 0) return Object.freeze({ status: 'failed', reasonCode: 'checks-failed' });
  return Object.freeze({ status: 'succeeded', reasonCode: 'checks-succeeded' });
}

/**
 * Observes main/merge-commit settlement for an already-completed merge
 * transaction and persists success/failure for the reconciliation stage.
 * Read-only against GitHub; safe to re-invoke on every cycle until terminal.
 */
export async function observePostMergeSettlement({ transactionId, store, checksClient, collectSettlement = collectGitHubCheckSnapshot, now = new Date().toISOString() } = {}) {
  const transaction = store.getTransaction(transactionId);
  if (!transaction || !['github_merged', 'completed'].includes(transaction.state)) {
    fail('transaction-not-completable', 'merge transaction is not ready for settlement observation');
  }
  if (!transaction.mergeCommitSha) return store.recordSettlement(transactionId, { status: 'pending', reasonCode: 'no-merge-commit-recorded', now });
  let snapshot;
  try {
    const raw = await collectSettlement({ repository: transaction.repository, sha: transaction.mergeCommitSha, requestJson: checksClient?.requestJson?.bind(checksClient), observedAt: now });
    snapshot = raw.snapshot ?? raw;
  } catch {
    return store.recordSettlement(transactionId, { status: 'pending', reasonCode: 'settlement-read-incomplete', now });
  }
  const classification = classifyPostMergeSettlement(snapshot.queryComplete !== false ? snapshot : { checks: null });
  return store.recordSettlement(transactionId, { status: classification.status, fingerprint: snapshot.fingerprint ?? null, reasonCode: classification.reasonCode, now });
}
