import assert from 'node:assert/strict';
import test from 'node:test';

import { collectQueueTriageGitHubEvidence } from './agent-runner-queue-triage-github-evidence.mjs';

const SHA = 'a'.repeat(40);
function project(overrides = {}) {
  return {
    projectId: 'alpha',
    repository: 'Owner/Alpha',
    acceptedAgentLabels: ['agent:claude', 'agent:codex'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress', blocked: 'status:blocked', done: 'status:done' },
    priorityLabels: ['priority:P0', 'priority:P1'],
    policy: { enabled: false },
    ...overrides,
  };
}
function release(overrides = {}) {
  return {
    batchId: 'batch-1',
    state: 'pending',
    payload: {
      schemaVersion: 1,
      batchId: 'batch-1',
      projectId: 'alpha',
      repository: 'Owner/Alpha',
      objectKind: 'issue',
      objectNumber: 7,
      shas: [{ sha: SHA, role: 'default_branch' }],
      settlement: { reason: 'settled', requiredShas: [SHA], terminalFailures: [] },
      deliveryIds: ['delivery-1'],
      ...overrides,
    },
  };
}
function client(handler) {
  const calls = [];
  return {
    calls,
    requestJson(endpoint, query = {}) {
      calls.push({ endpoint, query });
      return handler(endpoint, query);
    },
  };
}
function baseHandler(endpoint) {
  if (endpoint === '/repos/Owner/Alpha') return { full_name: 'Owner/Alpha', default_branch: 'main' };
  if (endpoint === '/repos/Owner/Alpha/commits/main') return { sha: 'b'.repeat(40) };
  if (endpoint === '/repos/Owner/Alpha/issues/7') return {
    number: 7,
    state: 'open',
    updated_at: '2026-07-29T18:01:00Z',
    labels: [{ name: 'priority:P0' }, { name: 'status:ready' }, { name: 'agent:claude' }],
    body: '## Dependencies\n- #2',
  };
  if (endpoint === '/repos/Owner/Alpha/issues/2') return { number: 2, state: 'closed', updated_at: '2026-07-29T17:00:00Z' };
  if (endpoint === '/repos/Owner/Alpha/issues/7/comments') return [{
    id: 11,
    created_at: '2026-07-29T18:02:00Z',
    updated_at: '2026-07-29T18:02:00Z',
    body: '<!-- agent-runner:manager-preflight -->\nRevision: `R1`\nFingerprint: `sha256:' + 'c'.repeat(64) + '`',
  }];
  if (endpoint.includes('/check-runs')) return { check_runs: [] };
  if (endpoint.includes('/check-suites')) return { check_suites: [] };
  if (endpoint.endsWith('/actions/runs')) return { workflow_runs: [] };
  if (endpoint.includes('/statuses')) return [];
  throw new Error(`unexpected ${endpoint}`);
}

test('collects one issue release through constructed GET surfaces and emits bounded planner evidence', () => {
  const gh = client(baseHandler);
  const evidence = collectQueueTriageGitHubEvidence({
    release: release(),
    project: project(),
    client: gh,
    observedAt: '2026-07-29T18:05:00Z',
  });
  assert.equal(evidence.releaseId, 'batch-1');
  assert.equal(evidence.changedItems.length, 1);
  assert.equal(evidence.changedItems[0].kind, 'issue');
  assert.equal(evidence.changedItems[0].githubReady, true);
  assert.deepEqual(evidence.changedItems[0].dependencies, [{ id: 'Owner/Alpha#2', complete: true }]);
  assert.deepEqual(evidence.changedItems[0].authority, { revision: 'R1', fingerprint: `sha256:${'c'.repeat(64)}` });
  assert.equal(evidence.liveEvidence.queryComplete, true);
  assert.equal(evidence.liveEvidence.commentsInspected, 1);
  assert.equal(Object.hasOwn(evidence.changedItems[0], 'body'), false);
  assert.ok(gh.calls.every(({ endpoint }) => endpoint.startsWith('/repos/')));
});

test('treats pull requests distinctly and normalizes reviews without raw bodies', () => {
  const gh = client((endpoint, query) => {
    if (endpoint === '/repos/Elsewhere/Beta') return { full_name: 'Elsewhere/Beta', default_branch: 'trunk' };
    if (endpoint === '/repos/Elsewhere/Beta/commits/trunk') return { sha: 'd'.repeat(40) };
    if (endpoint === '/repos/Elsewhere/Beta/issues/44') return {
      number: 44,
      state: 'open',
      updated_at: '2026-07-29T18:01:00Z',
      labels: ['priority:P1', 'status:in-progress', 'agent:local'],
      pull_request: { url: 'redacted' },
      body: '',
    };
    if (endpoint === '/repos/Elsewhere/Beta/pulls/44') return {
      number: 44, state: 'open', draft: true, merged: false,
      head: { sha: 'e'.repeat(40) }, base: { sha: 'f'.repeat(40) }, merge_commit_sha: null,
    };
    if (endpoint === '/repos/Elsewhere/Beta/pulls/44/reviews') return [{ id: 1, state: 'APPROVED', body: 'must not persist' }];
    if (endpoint === '/repos/Elsewhere/Beta/issues/44/comments') return [];
    if (endpoint.includes('/check-runs')) return { check_runs: [] };
    if (endpoint.includes('/check-suites')) return { check_suites: [] };
    if (endpoint.endsWith('/actions/runs')) return { workflow_runs: [] };
    if (endpoint.includes('/statuses')) return [];
    throw new Error(`unexpected ${endpoint} ${JSON.stringify(query)}`);
  });
  const betaRelease = {
    batchId: 'batch-beta', state: 'pending', payload: {
      schemaVersion: 1, batchId: 'batch-beta', projectId: 'beta', repository: 'Elsewhere/Beta',
      objectKind: 'pull_request', objectNumber: 44, shas: [{ sha: 'e'.repeat(40), role: 'pr_head' }],
      settlement: {}, deliveryIds: [],
    },
  };
  const evidence = collectQueueTriageGitHubEvidence({
    release: betaRelease,
    project: project({ projectId: 'beta', repository: 'Elsewhere/Beta', acceptedAgentLabels: ['agent:local'] }),
    client: gh,
    observedAt: '2026-07-29T18:05:00Z',
  });
  assert.equal(evidence.changedItems[0].kind, 'pull_request');
  assert.equal(evidence.liveEvidence.pullRequest.draft, true);
  assert.deepEqual(evidence.liveEvidence.pullRequest.reviewStates, ['APPROVED']);
  assert.equal(JSON.stringify(evidence).includes('must not persist'), false);
});

test('fails closed when release object kind changed', () => {
  const gh = client(baseHandler);
  assert.throws(() => collectQueueTriageGitHubEvidence({
    release: release({ objectKind: 'pull_request' }),
    project: project(),
    client: gh,
  }), /kind no longer matches/);
});

test('marks bounded pagination as incomplete instead of claiming complete evidence', () => {
  const gh = client((endpoint, query) => {
    if (endpoint === '/repos/Owner/Alpha/issues/7/comments') {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        created_at: '2026-07-29T18:02:00Z',
        updated_at: '2026-07-29T18:02:00Z',
        body: '',
      }));
    }
    return baseHandler(endpoint, query);
  });
  const evidence = collectQueueTriageGitHubEvidence({ release: release(), project: project(), client: gh });
  assert.equal(evidence.liveEvidence.queryComplete, false);
  assert.ok(evidence.liveEvidence.diagnostics.some((entry) => entry.surface === 'comments:7' && entry.code === 'bounded-limit-reached'));
});

test('issue policy text does not become a live hold without an explicit marker comment', () => {
  const gh = client((endpoint, query) => {
    if (endpoint === '/repos/Owner/Alpha/issues/7') {
      return { ...baseHandler(endpoint, query), body: 'The policy says do not claim old packets.' };
    }
    if (endpoint === '/repos/Owner/Alpha/issues/7/comments') return [];
    return baseHandler(endpoint, query);
  });
  const evidence = collectQueueTriageGitHubEvidence({ release: release(), project: project(), client: gh });
  assert.equal(evidence.changedItems[0].flags.explicitHold, false);
});
