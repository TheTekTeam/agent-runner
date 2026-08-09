import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IssueReconciliationStore } from './agent-runner-issue-reconciliation-store.mjs';
import {
  GhCliReconciliationClient, normalizeReconciliationRequest, evaluateIssueReconciliationEligibility,
  readReconciliationEvidence, reconcileMergedIssue, deleteMergedRemoteBranch,
} from './agent-runner-issue-reconciliation.mjs';

const HEAD = 'a'.repeat(40);
const MERGE_COMMIT = '9'.repeat(40);

function mergeTransaction(overrides = {}) {
  return {
    transactionId: 'merge-tx-0000000000000000000000000000000000000001',
    projectId: 'alpha-prj',
    repository: 'Owner/alpha',
    issueNumber: 156,
    prNumber: 99,
    sourceBranch: 'claude/issue-reconciliation-156',
    targetBranch: 'main',
    expectedHeadSha: HEAD,
    mergeCommitSha: MERGE_COMMIT,
    state: 'completed',
    settlementStatus: 'succeeded',
    ...overrides,
  };
}

function baseIssue(overrides = {}) {
  return {
    number: 156,
    state: 'open',
    state_reason: null,
    body: '## Acceptance criteria\n- [x] done thing\n',
    labels: [{ name: 'status:in-progress' }],
    ...overrides,
  };
}

function basePr(overrides = {}) {
  return {
    number: 99,
    state: 'closed',
    merged: true,
    head: { sha: HEAD, ref: 'claude/issue-reconciliation-156' },
    base: { ref: 'main' },
    merge_commit_sha: MERGE_COMMIT,
    body: 'Closes #156',
    title: 'feat: reconcile issue 156',
    ...overrides,
  };
}

/** Deliberately tiny fake surface mirroring GhCliReconciliationClient's allowlisted endpoints. */
function fakeClient({ issue = baseIssue(), pr = basePr(), branchSha = HEAD, openPrs = [], failPatch = false, failDelete = false } = {}) {
  const calls = [];
  let ref = branchSha;
  return {
    calls,
    setIssue(next) { issue = next; },
    request(method, url, fields) {
      calls.push({ method, url, fields });
      if (method === 'GET' && /\/issues\/\d+$/.test(url)) return issue;
      if (method === 'GET' && /\/pulls\/\d+$/.test(url)) return pr;
      if (method === 'GET' && /\/git\/ref\/heads\//.test(url)) return ref === null ? null : { object: { sha: ref } };
      if (method === 'GET' && /\/pulls\?/.test(url)) return url.includes('page=2') || url.includes('page=3') ? [] : openPrs;
      if (method === 'PATCH' && /\/issues\/\d+$/.test(url)) {
        if (failPatch) { const e = new Error('write failed'); e.code = 'provider-request-failed'; throw e; }
        if (fields.labels) issue = { ...issue, labels: fields.labels.map((name) => ({ name })) };
        if (fields.state === 'closed') issue = { ...issue, state: 'closed', state_reason: fields.state_reason };
        return issue;
      }
      if (method === 'DELETE' && /\/git\/refs\/heads\//.test(url)) {
        if (failDelete) { const e = new Error('delete failed'); e.code = 'provider-request-failed'; throw e; }
        ref = null;
        return {};
      }
      throw new Error(`unexpected call: ${method} ${url}`);
    },
  };
}

function harness() {
  const store = new IssueReconciliationStore(':memory:');
  return { store, close() { store.close(); } };
}

test('merged fixture issue transitions from in-progress to done/closed automatically with evidence', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient();
    const result = await reconcileMergedIssue({ request, store: h.store, client });
    assert.equal(result.closed, true);
    assert.equal(result.statusLabel, 'status:done');
    assert.equal(result.replayed, false);
    const patchCalls = client.calls.filter((c) => c.method === 'PATCH');
    assert.equal(patchCalls.length, 2);
    assert.deepEqual(patchCalls[0].fields, { labels: ['status:done'] });
    assert.deepEqual(patchCalls[1].fields, { state: 'closed', state_reason: 'completed' });
    const stored = h.store.getTransaction(request.transactionId);
    assert.equal(stored.state, 'completed');
    assert.ok(stored.beforeEvidence);
    assert.ok(stored.readbackEvidence);
  } finally { h.close(); }
});

test('replay of a completed reconciliation performs no GitHub calls', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient();
    await reconcileMergedIssue({ request, store: h.store, client });
    const before = client.calls.length;
    const replay = await reconcileMergedIssue({ request, store: h.store, client });
    assert.equal(replay.replayed, true);
    assert.equal(client.calls.length, before);
  } finally { h.close(); }
});

test('issue remains open when acceptance checklist is incomplete', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient({ issue: baseIssue({ body: '- [ ] outstanding item\n' }) });
    await assert.rejects(
      () => reconcileMergedIssue({ request, store: h.store, client }),
      (e) => e.code === 'acceptance-checklist-incomplete',
    );
    assert.equal(client.calls.some((c) => c.method === 'PATCH'), false);
    assert.equal(h.store.getTransaction(request.transactionId).state, 'attention');
  } finally { h.close(); }
});

test('exact-head drift between the merge transaction and the live PR refuses closure', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient({ pr: basePr({ head: { sha: 'b'.repeat(40), ref: 'claude/issue-reconciliation-156' } }) });
    await assert.rejects(
      () => reconcileMergedIssue({ request, store: h.store, client }),
      (e) => e.code === 'head-mismatch',
    );
    assert.equal(client.calls.some((c) => c.method === 'PATCH'), false);
  } finally { h.close(); }
});

test('a PR not yet linked to the issue refuses closure with ambiguous linkage', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient({ pr: basePr({ body: 'no linkage here', head: { sha: HEAD, ref: 'some-other-branch' } }) });
    await assert.rejects(
      () => reconcileMergedIssue({ request, store: h.store, client }),
      (e) => e.code === 'issue-linkage-ambiguous',
    );
  } finally { h.close(); }
});

test('a conflicting second open pull request referencing the same issue refuses closure', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient({ openPrs: [{ number: 101, body: 'Closes #156', title: 'other attempt', head: { ref: 'other/156' } }] });
    await assert.rejects(
      () => reconcileMergedIssue({ request, store: h.store, client }),
      (e) => e.code === 'conflicting-open-pull-request',
    );
  } finally { h.close(); }
});

test('an issue closed for an unrelated reason refuses further mutation', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient({ issue: baseIssue({ state: 'closed', state_reason: 'not_planned' }) });
    await assert.rejects(
      () => reconcileMergedIssue({ request, store: h.store, client }),
      (e) => e.code === 'issue-closed-unexpected-reason',
    );
    assert.equal(client.calls.some((c) => c.method === 'PATCH'), false);
  } finally { h.close(); }
});

test('an already-reconciled issue is adopted idempotently without duplicate writes', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient({ issue: baseIssue({ state: 'closed', state_reason: 'completed', labels: [{ name: 'status:done' }] }) });
    const result = await reconcileMergedIssue({ request, store: h.store, client });
    assert.equal(result.closed, true);
    assert.equal(client.calls.some((c) => c.method === 'PATCH'), false);
  } finally { h.close(); }
});

test('a merge transaction that has not settled refuses to normalize', () => {
  assert.throws(
    () => normalizeReconciliationRequest(mergeTransaction({ settlementStatus: 'pending' })),
    (e) => e.code === 'merge-not-settled',
  );
  assert.throws(
    () => normalizeReconciliationRequest(mergeTransaction({ state: 'github_merged' })),
    (e) => e.code === 'merge-not-settled',
  );
});

test('a retried attention refusal re-evaluates fresh evidence instead of staying stuck', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const incompleteClient = fakeClient({ issue: baseIssue({ body: '- [ ] outstanding item\n' }) });
    await assert.rejects(() => reconcileMergedIssue({ request, store: h.store, client: incompleteClient }));
    const completedClient = fakeClient();
    const result = await reconcileMergedIssue({ request, store: h.store, client: completedClient });
    assert.equal(result.closed, true);
  } finally { h.close(); }
});

test('remote branch deletion is refused before issue reconciliation has completed', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient();
    await assert.rejects(
      () => deleteMergedRemoteBranch({ request, store: h.store, client }),
      (e) => e.code === 'reconciliation-not-ready',
    );
  } finally { h.close(); }
});

test('remote branch deletion succeeds only for the exact merged head and is idempotent on replay', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient();
    await reconcileMergedIssue({ request, store: h.store, client });
    const deletion = await deleteMergedRemoteBranch({ request, store: h.store, client });
    assert.equal(deletion.deleted, true);
    assert.equal(deletion.replayed, false);
    const replay = await deleteMergedRemoteBranch({ request, store: h.store, client });
    assert.equal(replay.replayed, true);
    assert.equal(client.calls.filter((c) => c.method === 'DELETE').length, 1);
  } finally { h.close(); }
});

test('remote branch deletion refuses a branch that has advanced past the merged commit', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient({ branchSha: 'c'.repeat(40) });
    await reconcileMergedIssue({ request, store: h.store, client });
    await assert.rejects(
      () => deleteMergedRemoteBranch({ request, store: h.store, client }),
      (e) => e.code === 'branch-has-later-work',
    );
    assert.equal(client.calls.some((c) => c.method === 'DELETE'), false);
  } finally { h.close(); }
});

test('remote branch deletion refuses a branch that still backs an open pull request', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    await reconcileMergedIssue({ request, store: h.store, client: fakeClient() });
    // A distinct open PR head coincidentally reusing the merged branch name --
    // discovered fresh only at branch-deletion time, after reconciliation
    // already completed against evidence that had no such conflict.
    const deleteClient = fakeClient({ openPrs: [{ number: 200, body: '', title: '', head: { ref: request.sourceBranch } }] });
    await assert.rejects(
      () => deleteMergedRemoteBranch({ request, store: h.store, client: deleteClient }),
      (e) => e.code === 'branch-has-open-pull-request',
    );
    assert.equal(deleteClient.calls.some((c) => c.method === 'DELETE'), false);
  } finally { h.close(); }
});

test('remote branch deletion adopts an already-absent branch idempotently', async () => {
  const h = harness();
  try {
    const request = normalizeReconciliationRequest(mergeTransaction());
    const client = fakeClient({ branchSha: null });
    await reconcileMergedIssue({ request, store: h.store, client });
    const deletion = await deleteMergedRemoteBranch({ request, store: h.store, client });
    assert.equal(deletion.deleted, true);
    assert.equal(deletion.alreadyAbsent, true);
    assert.equal(client.calls.some((c) => c.method === 'DELETE'), false);
  } finally { h.close(); }
});

test('two materially different fixture repositories use the same reconciliation path', async () => {
  const h = harness();
  try {
    const alpha = normalizeReconciliationRequest(mergeTransaction());
    const bravo = normalizeReconciliationRequest(mergeTransaction({
      transactionId: 'merge-tx-0000000000000000000000000000000000000002',
      projectId: 'bravo-prj', repository: 'Other/bravo', issueNumber: 42, prNumber: 7,
      sourceBranch: 'codex/issue-42', targetBranch: 'develop',
    }));
    const bravoClient = fakeClient({
      issue: baseIssue({ number: 42, labels: [{ name: 'status:ready' }] }),
      pr: basePr({ number: 7, base: { ref: 'develop' }, head: { sha: HEAD, ref: 'codex/issue-42' }, body: 'Fixes #42', title: 'fix: issue 42' }),
    });
    const alphaResult = await reconcileMergedIssue({ request: alpha, store: h.store, client: fakeClient() });
    const bravoResult = await reconcileMergedIssue({ request: bravo, store: h.store, client: bravoClient });
    assert.equal(alphaResult.closed, true);
    assert.equal(bravoResult.closed, true);
  } finally { h.close(); }
});

test('the GitHub client refuses endpoints and methods outside its bounded allowlist', () => {
  const client = new GhCliReconciliationClient({ spawn: () => { throw new Error('must not spawn'); } });
  assert.throws(() => client.request('GET', '/repos/o/r/actions/runs'), /not allowlisted/);
  assert.throws(() => client.request('DELETE', '/repos/o/r/issues/1'), /not allowlisted/);
  assert.throws(() => client.request('PATCH', '/repos/o/r/pulls/1'), /not allowlisted/);
  assert.throws(() => client.request('POST', '/repos/o/r/issues/1'), /not allowlisted/);
});

test('readReconciliationEvidence and evaluateIssueReconciliationEligibility compose without mutation', () => {
  const request = normalizeReconciliationRequest(mergeTransaction());
  const client = fakeClient();
  const evidence = readReconciliationEvidence({ client, request });
  const eligibility = evaluateIssueReconciliationEligibility(evidence, request);
  assert.equal(eligibility.eligible, true);
  assert.equal(client.calls.every((c) => c.method === 'GET'), true);
});
