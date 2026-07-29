import assert from 'node:assert/strict';
import test from 'node:test';

import { pollRegisteredGitHubProjects } from './agent-runner-github-polling-source.mjs';

const OBSERVED_AT = '2026-07-29T06:00:00.000Z';
const RECENT = '2026-07-29T05:55:00.000Z';
const OLD = '2026-07-27T06:00:00.000Z';
const MAIN_A = 'a'.repeat(40);
const MAIN_B = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);

function issue(number, updatedAt) {
  return {
    number,
    state: 'open',
    state_reason: null,
    updated_at: updatedAt,
    labels: [],
    assignees: [],
    milestone: null,
  };
}

function prStub(number, updatedAt) {
  return { number, updated_at: updatedAt, pull_request: { url: `https://api.github.invalid/pulls/${number}` } };
}

function pullRequest(number, {
  state = 'open',
  updatedAt = RECENT,
  mergedAt = null,
  mergeSha = null,
} = {}) {
  return {
    number,
    state,
    draft: false,
    merged_at: mergedAt,
    merge_commit_sha: mergeSha,
    mergeable_state: 'clean',
    updated_at: updatedAt,
    head: { sha: HEAD, ref: `feature-${number}` },
    base: { sha: BASE, ref: 'main' },
    labels: [],
    requested_reviewers: [],
  };
}

class MemoryPollingStore {
  constructor() {
    this.cursors = new Map();
  }

  getCursor(projectId) {
    return this.cursors.get(projectId) ?? null;
  }

  commitCursor(project, { observedAt, defaultSha }) {
    const cursor = {
      projectId: project.projectId,
      repository: project.githubRepo,
      lastSuccessAt: observedAt,
      lastDefaultSha: defaultSha,
      updatedAt: observedAt,
    };
    this.cursors.set(project.projectId, cursor);
    return cursor;
  }
}

class MemoryIngressStore {
  constructor() {
    this.deliveries = new Map();
  }

  recordDelivery(envelope) {
    const inserted = !this.deliveries.has(envelope.deliveryId);
    if (inserted) this.deliveries.set(envelope.deliveryId, envelope);
    return { inserted, delivery: envelope };
  }
}

class FakeClient {
  constructor() {
    this.mainSha = MAIN_A;
    this.issueItems = [
      issue(1, RECENT),
      issue(2, RECENT),
      prStub(99, RECENT),
      issue(3, OLD),
    ];
    this.openPrItems = [pullRequest(5)];
    this.prs = new Map([
      [5, pullRequest(5)],
      [99, pullRequest(99, { state: 'closed', updatedAt: RECENT, mergedAt: RECENT, mergeSha: MAIN_B })],
    ]);
    this.calls = [];
  }

  async requestJson(endpoint, query = {}) {
    this.calls.push({ endpoint, query });
    if (endpoint === '/repos/Owner/Alpha') return { default_branch: 'main' };
    if (endpoint === '/repos/Owner/Alpha/commits/main') return { sha: this.mainSha };
    if (endpoint === '/repos/Owner/Alpha/issues') return query.page === 1 ? this.issueItems : [];
    if (endpoint === '/repos/Owner/Alpha/pulls') return query.page === 1 ? this.openPrItems : [];
    const match = endpoint.match(/^\/repos\/Owner\/Alpha\/pulls\/(\d+)$/);
    if (match) return this.prs.get(Number(match[1]));
    throw new Error(`unexpected endpoint ${endpoint}`);
  }
}

const registry = {
  projects: [{ projectId: 'alpha', githubRepo: 'Owner/Alpha' }],
};

function poll({ client, pollingStore, ingressStore, observedAt = OBSERVED_AT, ...overrides }) {
  return pollRegisteredGitHubProjects({
    registry,
    pollingStore,
    ingressStore,
    client,
    observedAt,
    overlapMs: 0,
    bootstrapLookbackMs: 24 * 60 * 60_000,
    bootstrapIssueLimit: 1,
    ...overrides,
  });
}

test('bootstrap caps recent issues, excludes old issues and does not fetch recently closed PRs', async () => {
  const client = new FakeClient();
  const pollingStore = new MemoryPollingStore();
  const ingressStore = new MemoryIngressStore();

  const result = await poll({ client, pollingStore, ingressStore });
  const outcome = result.outcomes[0];

  assert.equal(outcome.bootstrap, true);
  assert.equal(outcome.since, null);
  assert.equal(outcome.issuesObserved, 1);
  assert.equal(outcome.pullRequestsObserved, 1);
  assert.equal(result.deliveriesInserted, 3);
  assert.ok([...ingressStore.deliveries.values()].some((item) => item.issueNumber === 1));
  assert.equal([...ingressStore.deliveries.values()].some((item) => item.issueNumber === 2), false);
  assert.equal([...ingressStore.deliveries.values()].some((item) => item.issueNumber === 3), false);
  assert.equal(client.calls.some((call) => call.endpoint.endsWith('/pulls/99')), false);
  assert.ok(client.calls.some((call) => call.endpoint.endsWith('/pulls/5')));
});

test('incremental polling still fetches a changed closed PR and changed default branch', async () => {
  const client = new FakeClient();
  const pollingStore = new MemoryPollingStore();
  const ingressStore = new MemoryIngressStore();
  await poll({ client, pollingStore, ingressStore });

  client.issueItems = [prStub(99, '2026-07-29T06:01:00.000Z')];
  client.openPrItems = [];
  client.mainSha = MAIN_B;

  const result = await poll({
    client,
    pollingStore,
    ingressStore,
    observedAt: '2026-07-29T06:01:00.000Z',
  });
  const outcome = result.outcomes[0];

  assert.equal(outcome.bootstrap, false);
  assert.equal(outcome.pullRequestsObserved, 1);
  assert.equal(result.deliveriesInserted, 2);
  assert.ok([...ingressStore.deliveries.values()].some((item) => item.pullRequestNumber === 99 && item.mergeSha === MAIN_B));
  assert.ok([...ingressStore.deliveries.values()].some((item) => item.afterSha === MAIN_B));
});

test('zero bootstrap issue limit still captures open PRs and the default branch', async () => {
  const client = new FakeClient();
  const pollingStore = new MemoryPollingStore();
  const ingressStore = new MemoryIngressStore();

  const result = await poll({
    client,
    pollingStore,
    ingressStore,
    bootstrapIssueLimit: 0,
  });

  assert.equal(result.outcomes[0].issuesObserved, 0);
  assert.equal(result.outcomes[0].pullRequestsObserved, 1);
  assert.equal(result.deliveriesInserted, 2);
});
