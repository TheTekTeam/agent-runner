import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MERGE_HUMAN_GATE_NAMES, normalizeMergeDecisionRequest } from './agent-runner-merge-policy.mjs';
import { MergeTransactionStore } from './agent-runner-merge-transaction-store.mjs';
import {
  executeMergeTransaction, observePostMergeSettlement, settleReviews,
} from './agent-runner-merge-transaction.mjs';

const NO_GATES = Object.freeze(Object.fromEntries(MERGE_HUMAN_GATE_NAMES.map((name) => [name, false])));
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE_COMMIT = '9'.repeat(40);

const request = (overrides) => normalizeMergeDecisionRequest({
  projectId: 'alpha-prj', repository: 'Owner/alpha', issueNumber: 155, prNumber: 42,
  sourceBranch: 'codex/pr-155', targetBranch: 'main', expectedHeadSha: HEAD, expectedBaseSha: BASE,
  managerRevision: 'AR155-MERGE-2026-08-09.1', managerFingerprint: `sha256:${'c'.repeat(64)}`,
  executorJobId: 'executor-job-00000001', requestId: 'request-0000000001', riskClass: 'R1',
  gates: NO_GATES, automaticMergeAuthority: true,
  requiredValidationProfiles: [{ profile: 'focused', validationId: 'validation-00000001' }],
  mergeMethod: 'squash', requiredApprovals: 1,
  approvedScope: 'Merge the exact-head validated implementation for issue #155.',
  ...overrides,
});

function basePr(overrides = {}) {
  return {
    number: 42,
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    head: { sha: HEAD, ref: 'codex/pr-155' },
    base: { sha: BASE, ref: 'main' },
    merge_commit_sha: null,
    requested_reviewers: [],
    requested_teams: [],
    ...overrides,
  };
}

function approvedReview() {
  return { user: { login: 'reviewer-1' }, state: 'APPROVED', submitted_at: '2029-01-01T00:00:00.000Z' };
}

function fakeMergeClient({ pr = basePr(), reviews = [approvedReview()], baseSha = BASE, failMerge = false } = {}) {
  const calls = [];
  return {
    calls,
    pr,
    request(method, url, fields) {
      calls.push({ method, url, fields });
      if (url.includes('/reviews')) return reviews;
      if (url.includes('/git/ref/heads/')) return { object: { sha: baseSha } };
      if (method === 'PUT' && url.endsWith('/merge')) {
        if (failMerge) { const e = new Error('merge request failed'); e.code = 'provider-request-failed'; throw e; }
        pr.merged = true;
        pr.merge_commit_sha = MERGE_COMMIT;
        return { merged: true, sha: MERGE_COMMIT };
      }
      if (/\/pulls\/\d+(?:\?.*)?$/.test(url)) return pr;
      throw new Error(`unexpected call: ${url}`);
    },
  };
}

function fakeChecksClient(checks = [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }]) {
  return {
    async requestJson(endpoint) {
      if (endpoint.includes('/check-runs')) return { check_runs: checks };
      if (endpoint.includes('/check-suites')) return { check_suites: [] };
      if (endpoint.includes('/actions/runs')) return { workflow_runs: [] };
      if (endpoint.includes('/statuses')) return { statuses: [] };
      throw new Error(`unexpected checks endpoint: ${endpoint}`);
    },
  };
}

const VALIDATION_PROJECTS = new Map([['validation-00000001', 'alpha-prj'], ['validation-00000002', 'bravo-prj']]);
const evidence = {
  get: (validationId) => {
    const projectId = VALIDATION_PROJECTS.get(validationId);
    return projectId ? {
      schemaVersion: 1, state: 'succeeded', projectId, profile: 'focused', expectedSha: HEAD, observedSha: HEAD,
      profileContractSha256: 'c'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z',
    } : null;
  },
};
const profileContracts = { focused: 'c'.repeat(64) };

function harness() {
  const store = new MergeTransactionStore(':memory:');
  return { store, close() { store.close(); } };
}

test('eligible low/medium-risk fixture PR merges exactly once with positive authority and exact head', async () => {
  const h = harness();
  const client = fakeMergeClient();
  try {
    const result = await executeMergeTransaction({
      request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
      profileContracts, authorityCheck: async () => true, now: '2029-01-01T00:00:00.000Z',
    });
    assert.equal(result.prNumber, 42);
    assert.equal(result.mergeCommitSha, MERGE_COMMIT);
    assert.equal(result.replayed, false);
    assert.equal(client.calls.filter((c) => c.method === 'PUT').length, 1);
    const stored = h.store.getTransaction(result.transactionId);
    assert.equal(stored.state, 'completed');
    assert.equal(stored.mergeCommitSha, MERGE_COMMIT);
  } finally { h.close(); }
});

test('high-risk classification fails closed before any GitHub read', async () => {
  const h = harness();
  const client = fakeMergeClient();
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request({ riskClass: 'R3' }), store: h.store, client, checksClient: fakeChecksClient(),
        evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'high-risk-classification',
    );
    assert.equal(client.calls.length, 0);
  } finally { h.close(); }
});

test('a true human gate fails closed regardless of automatic-merge authority', async () => {
  const h = harness();
  const client = fakeMergeClient();
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request({ gates: { ...NO_GATES, secretCredential: true } }), store: h.store, client,
        checksClient: fakeChecksClient(), evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'human-gate-required',
    );
    assert.equal(client.calls.length, 0);
  } finally { h.close(); }
});

test('missing automatic-merge authority fails closed', async () => {
  const h = harness();
  const client = fakeMergeClient();
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request({ automaticMergeAuthority: false }), store: h.store, client, checksClient: fakeChecksClient(),
        evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'automatic-merge-authority-missing',
    );
    assert.equal(client.calls.length, 0);
  } finally { h.close(); }
});

test('stale manager authority fails closed without merging', async () => {
  const h = harness();
  const client = fakeMergeClient();
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
        profileContracts, authorityCheck: async () => false,
      }),
      (e) => e.code === 'manager-authority-stale',
    );
    assert.equal(client.calls.filter((c) => c.method === 'PUT').length, 0);
    assert.equal(h.store.getTransaction(request().transactionId).state, 'failed');
  } finally { h.close(); }
});

test('missing, expired and cross-project validation evidence all fail closed', async () => {
  const h = harness();
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request({ requiredValidationProfiles: [{ profile: 'focused', validationId: 'validation-missing' }] }),
        store: h.store, client: fakeMergeClient(), checksClient: fakeChecksClient(), evidenceStore: evidence,
        profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'validation-evidence-missing',
    );
    await assert.rejects(
      () => executeMergeTransaction({
        request: request({ requiredValidationProfiles: [{ profile: 'focused', validationId: 'validation-00000002' }] }),
        store: h.store, client: fakeMergeClient(), checksClient: fakeChecksClient(), evidenceStore: evidence,
        profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'validation-evidence-failed',
    );
  } finally { h.close(); }
});

test('exact-head and base drift both fail closed', async () => {
  const h = harness();
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request(), store: h.store, client: fakeMergeClient({ pr: basePr({ head: { sha: 'd'.repeat(40), ref: 'codex/pr-155' } }) }),
        checksClient: fakeChecksClient(), evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'head-changed',
    );
    await assert.rejects(
      () => executeMergeTransaction({
        request: request({ requestId: 'request-0000000002' }), store: h.store,
        client: fakeMergeClient({ baseSha: 'e'.repeat(40) }), checksClient: fakeChecksClient(),
        evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'base-changed',
    );
  } finally { h.close(); }
});

test('unsettled and failed checks both fail closed without merging', async () => {
  const h = harness();
  try {
    const pending = fakeMergeClient();
    await assert.rejects(
      () => executeMergeTransaction({
        request: request(), store: h.store, client: pending,
        checksClient: fakeChecksClient([{ id: 1, name: 'ci', status: 'in_progress', conclusion: null }]),
        evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'checks-unsettled',
    );
    assert.equal(pending.calls.filter((c) => c.method === 'PUT').length, 0);
    const failing = fakeMergeClient();
    await assert.rejects(
      () => executeMergeTransaction({
        request: request({ requestId: 'request-0000000003' }), store: h.store, client: failing,
        checksClient: fakeChecksClient([{ id: 1, name: 'ci', status: 'completed', conclusion: 'failure' }]),
        evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'checks-failed',
    );
    assert.equal(failing.calls.filter((c) => c.method === 'PUT').length, 0);
  } finally { h.close(); }
});

test('an unmet review requirement fails closed', async () => {
  const h = harness();
  try {
    const noReviews = fakeMergeClient({ reviews: [] });
    await assert.rejects(
      () => executeMergeTransaction({
        request: request(), store: h.store, client: noReviews, checksClient: fakeChecksClient(),
        evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'review-required',
    );
    const changesRequested = fakeMergeClient({
      reviews: [{ user: { login: 'reviewer-1' }, state: 'CHANGES_REQUESTED', submitted_at: '2029-01-01T00:00:00.000Z' }],
    });
    await assert.rejects(
      () => executeMergeTransaction({
        request: request({ requestId: 'request-0000000004' }), store: h.store, client: changesRequested,
        checksClient: fakeChecksClient(), evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'review-required',
    );
    assert.equal(noReviews.calls.filter((c) => c.method === 'PUT').length, 0);
    assert.equal(changesRequested.calls.filter((c) => c.method === 'PUT').length, 0);
  } finally { h.close(); }
});

test('a merge conflict fails closed without calling merge', async () => {
  const h = harness();
  const client = fakeMergeClient({ pr: basePr({ mergeable: false, mergeable_state: 'dirty' }) });
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
        profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'merge-conflict',
    );
    assert.equal(client.calls.filter((c) => c.method === 'PUT').length, 0);
  } finally { h.close(); }
});

test('ambiguous mergeability (unknown/blocked) fails closed', async () => {
  const h = harness();
  const client = fakeMergeClient({ pr: basePr({ mergeable: null, mergeable_state: 'unknown' }) });
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
        profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'not-mergeable',
    );
    assert.equal(client.calls.filter((c) => c.method === 'PUT').length, 0);
  } finally { h.close(); }
});

test('a draft or non-open pull request fails closed', async () => {
  const h = harness();
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request(), store: h.store, client: fakeMergeClient({ pr: basePr({ draft: true }) }),
        checksClient: fakeChecksClient(), evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'pr-draft',
    );
    await assert.rejects(
      () => executeMergeTransaction({
        request: request({ requestId: 'request-0000000005' }), store: h.store,
        client: fakeMergeClient({ pr: basePr({ state: 'closed' }) }), checksClient: fakeChecksClient(),
        evidenceStore: evidence, profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'pr-not-open',
    );
  } finally { h.close(); }
});

test('restart replays a completed identity with no additional GitHub calls and no second merge', async () => {
  const h = harness();
  const client = fakeMergeClient();
  try {
    const first = await executeMergeTransaction({
      request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
      profileContracts, authorityCheck: async () => true, now: '2029-01-01T00:00:00.000Z',
    });
    const callsBefore = client.calls.length;
    const replay = await executeMergeTransaction({
      request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
      profileContracts, authorityCheck: async () => true, now: '2029-01-01T00:05:00.000Z',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.transactionId, first.transactionId);
    assert.equal(replay.mergeCommitSha, MERGE_COMMIT);
    assert.equal(client.calls.length, callsBefore);
    assert.equal(client.calls.filter((c) => c.method === 'PUT').length, 1);
  } finally { h.close(); }
});

test('resuming after a crash between GitHub confirming the merge and recording it never re-merges', async () => {
  const h = harness();
  const req = request();
  const mergedPr = basePr({ merged: true, merge_commit_sha: MERGE_COMMIT });
  const client = fakeMergeClient({ pr: mergedPr });
  try {
    h.store.beginTransaction(req, { now: '2029-01-01T00:00:00.000Z' });
    h.store.recordGithubMerged(req.transactionId, {
      before: { pr: { headSha: HEAD } }, intended: { headSha: HEAD }, mergeCommitSha: MERGE_COMMIT, now: '2029-01-01T00:00:01.000Z',
    });
    const result = await executeMergeTransaction({
      request: req, store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
      profileContracts, authorityCheck: async () => true, now: '2029-01-01T00:05:00.000Z',
    });
    assert.equal(result.replayed, false);
    assert.equal(result.mergeCommitSha, MERGE_COMMIT);
    assert.equal(client.calls.filter((c) => c.method === 'PUT').length, 0);
    assert.equal(h.store.getTransaction(req.transactionId).state, 'completed');
  } finally { h.close(); }
});

test('a fresh pending row adopts a merge that already landed instead of merging twice', async () => {
  const h = harness();
  const req = request();
  const mergedPr = basePr({ merged: true, merge_commit_sha: MERGE_COMMIT });
  const client = fakeMergeClient({ pr: mergedPr });
  try {
    const result = await executeMergeTransaction({
      request: req, store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
      profileContracts, authorityCheck: async () => true, now: '2029-01-01T00:00:00.000Z',
    });
    assert.equal(result.mergeCommitSha, MERGE_COMMIT);
    assert.equal(client.calls.filter((c) => c.method === 'PUT').length, 0);
    assert.equal(h.store.getTransaction(req.transactionId).state, 'completed');
  } finally { h.close(); }
});

test('an already-merged PR with an unexpected head fails closed as ambiguous', async () => {
  const h = harness();
  const client = fakeMergeClient({ pr: basePr({ merged: true, head: { sha: 'f'.repeat(40) }, merge_commit_sha: MERGE_COMMIT }) });
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
        profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'unexpected-merge-state',
    );
    assert.equal(client.calls.filter((c) => c.method === 'PUT').length, 0);
  } finally { h.close(); }
});

test('a partial GitHub read fails closed', async () => {
  const h = harness();
  const client = {
    calls: [],
    request(method, url) {
      this.calls.push({ method, url });
      if (url.includes('/reviews')) return [approvedReview()];
      if (url.includes('/git/ref/heads/')) return { object: { sha: BASE } };
      if (/\/pulls\/\d+(?:\?.*)?$/.test(url)) { const e = new Error('boom'); e.code = 'provider-read-failed'; throw e; }
      throw new Error('unexpected call');
    },
  };
  try {
    await assert.rejects(
      () => executeMergeTransaction({
        request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
        profileContracts, authorityCheck: async () => true,
      }),
      (e) => e.code === 'partial-github-read',
    );
  } finally { h.close(); }
});

test('two materially different configured repositories use the same transaction path independently', async () => {
  const h = harness();
  const alphaClient = fakeMergeClient();
  const bravoClient = fakeMergeClient({ pr: basePr({ number: 7 }) });
  try {
    const alpha = await executeMergeTransaction({
      request: request(), store: h.store, client: alphaClient, checksClient: fakeChecksClient(), evidenceStore: evidence,
      profileContracts, authorityCheck: async () => true, now: '2029-01-01T00:00:00.000Z',
    });
    const bravo = await executeMergeTransaction({
      request: request({
        projectId: 'bravo-prj', repository: 'Other/bravo', prNumber: 7, requestId: 'request-0000000002',
        executorJobId: 'executor-job-00000002', requiredValidationProfiles: [{ profile: 'focused', validationId: 'validation-00000002' }],
      }),
      store: h.store, client: bravoClient, checksClient: fakeChecksClient(), evidenceStore: evidence,
      profileContracts, authorityCheck: async () => true, now: '2029-01-01T00:00:00.000Z',
    });
    assert.notEqual(alpha.transactionId, bravo.transactionId);
    assert.equal(alphaClient.calls.filter((c) => c.method === 'PUT').length, 1);
    assert.equal(bravoClient.calls.filter((c) => c.method === 'PUT').length, 1);
  } finally { h.close(); }
});

test('a concurrent merge transaction for the same pull request is refused', async () => {
  const h = harness();
  const req = request();
  h.store.beginTransaction(req, { now: '2029-01-01T00:00:00.000Z' });
  try {
    // A different expected head SHA changes the idempotency identity, so this is a genuinely
    // distinct transaction attempt for the same still-pending PR, not a replay of the first.
    assert.throws(
      () => h.store.beginTransaction(request({ expectedHeadSha: 'd'.repeat(40), requestId: 'request-0000000099' }), { now: '2029-01-01T00:00:01.000Z' }),
      (e) => e.code === 'concurrent-transaction-active',
    );
  } finally { h.close(); }
});

test('settleReviews requires zero pending requests, no changes requested and enough approvals', () => {
  assert.equal(settleReviews({ requiredApprovals: 0 }).settled, true);
  assert.equal(settleReviews({ reviews: [], requiredApprovals: 1 }).settled, false);
  assert.equal(settleReviews({ reviews: [approvedReview()], requestedReviewersCount: 1, requiredApprovals: 1 }).settled, false);
  assert.equal(settleReviews({ reviews: [approvedReview()], requiredApprovals: 1 }).settled, true);
});

test('post-merge settlement is observed and persisted as pending, succeeded and failed', async () => {
  const h = harness();
  const client = fakeMergeClient();
  try {
    const result = await executeMergeTransaction({
      request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
      profileContracts, authorityCheck: async () => true, now: '2029-01-01T00:00:00.000Z',
    });
    const pending = await observePostMergeSettlement({
      transactionId: result.transactionId, store: h.store,
      collectSettlement: async () => ({ snapshot: { queryComplete: true, checks: [], fingerprint: 'f1' } }),
    });
    assert.equal(pending.settlementStatus, 'pending');
    const succeeded = await observePostMergeSettlement({
      transactionId: result.transactionId, store: h.store,
      collectSettlement: async () => ({ snapshot: { queryComplete: true, checks: [{ terminal: true, conclusion: 'success' }], fingerprint: 'f2' } }),
    });
    assert.equal(succeeded.settlementStatus, 'succeeded');
    assert.equal(succeeded.settlementFingerprint, 'f2');
    const failed = await observePostMergeSettlement({
      transactionId: result.transactionId, store: h.store,
      collectSettlement: async () => ({ snapshot: { queryComplete: true, checks: [{ terminal: true, conclusion: 'failure' }], fingerprint: 'f3' } }),
    });
    assert.equal(failed.settlementStatus, 'failed');
  } finally { h.close(); }
});

test('post-merge settlement read failures are recorded as pending rather than throwing', async () => {
  const h = harness();
  const client = fakeMergeClient();
  try {
    const result = await executeMergeTransaction({
      request: request(), store: h.store, client, checksClient: fakeChecksClient(), evidenceStore: evidence,
      profileContracts, authorityCheck: async () => true,
    });
    const settlement = await observePostMergeSettlement({
      transactionId: result.transactionId, store: h.store, collectSettlement: async () => { throw new Error('rate limited'); },
    });
    assert.equal(settlement.settlementStatus, 'pending');
    assert.equal(settlement.settlementReasonCode, 'settlement-read-incomplete');
  } finally { h.close(); }
});
