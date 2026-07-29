import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventControllerReleaseStore } from './agent-runner-event-controller.mjs';
import { EventIngressStore } from './agent-runner-event-ingress.mjs';
import { EventSettlementStore } from './agent-runner-event-settlement.mjs';
import {
  GitHubPollingStore,
  pollRegisteredGitHubProjects,
} from './agent-runner-github-polling-source.mjs';
import { runPollingControllerCycle } from './agent-runner-polling-controller-cycle.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';

const T0 = Date.parse('2026-07-29T06:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const ALPHA_MAIN = 'a'.repeat(40);
const BETA_MAIN = 'b'.repeat(40);
const PR_HEAD = 'c'.repeat(40);
const PR_BASE = 'd'.repeat(40);

function projectConfig(projectId, githubRepo, localRepoPath) {
  return {
    projectId,
    displayName: projectId,
    githubRepo,
    localRepoPath,
    outputDir: '.var/agent-runner',
    stateDbPath: `.var/agent-runner/${projectId}.sqlite`,
    acceptedAgentLabels: ['agent:chatgpt'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: ['node --test'],
    systemd: { serviceName: `${projectId}.service`, timerName: `${projectId}.timer` },
    runner: { lockPath: `.var/agent-runner/${projectId}.lock`, candidateLimit: 10 },
  };
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-github-polling-'));
  try {
    writeFileSync(join(dir, 'alpha.json'), JSON.stringify(projectConfig('alpha', 'Owner/Alpha', '/srv/alpha')));
    writeFileSync(join(dir, 'beta.json'), JSON.stringify(projectConfig('beta', 'Owner/Beta', '/srv/beta')));
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: ['alpha.json', 'beta.json'] }));
    const dbPath = join(dir, 'controller.sqlite');
    const context = {
      registry: loadProjectRegistry({ registryPath }),
      polling: new GitHubPollingStore(dbPath),
      ingress: new EventIngressStore(dbPath),
      settlement: new EventSettlementStore(dbPath),
      releases: new EventControllerReleaseStore(dbPath),
      dbPath,
    };
    try {
      return await fn(context);
    } finally {
      context.releases.close();
      context.settlement.close();
      context.ingress.close();
      context.polling.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function issue(number = 1, updatedAt = at(0)) {
  return {
    number,
    state: 'open',
    state_reason: null,
    updated_at: updatedAt,
    labels: [{ name: 'status:ready' }, { name: 'priority:P0' }],
    assignees: [],
    milestone: null,
  };
}

function prStub(number = 2, updatedAt = at(0)) {
  return { number, updated_at: updatedAt, pull_request: { url: `https://api.github.invalid/pulls/${number}` } };
}

function pullRequest({
  number = 2,
  updatedAt = at(0),
  state = 'open',
  mergedAt = null,
  mergeSha = null,
  headSha = PR_HEAD,
  baseSha = PR_BASE,
} = {}) {
  return {
    number,
    state,
    draft: false,
    merged_at: mergedAt,
    merge_commit_sha: mergeSha,
    mergeable_state: 'clean',
    updated_at: updatedAt,
    head: { sha: headSha, ref: `feature-${number}` },
    base: { sha: baseSha, ref: 'main' },
    labels: [],
    requested_reviewers: [],
  };
}

class FakeGitHubClient {
  constructor() {
    this.mainShas = { 'Owner/Alpha': ALPHA_MAIN, 'Owner/Beta': BETA_MAIN };
    this.issues = { 'Owner/Alpha': [issue(), prStub()], 'Owner/Beta': [] };
    this.openPrs = { 'Owner/Alpha': [pullRequest()], 'Owner/Beta': [] };
    this.prs = { 'Owner/Alpha#2': pullRequest() };
    this.failRepository = null;
    this.calls = [];
  }

  async requestJson(endpoint, query = {}) {
    this.calls.push({ endpoint, query });
    const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(endpoint);
    const repository = match?.[1] ?? null;
    const suffix = match?.[2] ?? '';
    if (repository && this.failRepository === repository) {
      const error = new Error('provider failed');
      error.code = 'provider-read-failed';
      throw error;
    }

    if (repository && suffix === '') return { default_branch: 'main' };
    if (repository && suffix === '/commits/main') return { sha: this.mainShas[repository] };
    if (repository && suffix === '/issues') return query.page === 1 ? this.issues[repository] : [];
    if (repository && suffix === '/pulls') return query.page === 1 ? this.openPrs[repository] : [];
    const prMatch = suffix.match(/^\/pulls\/(\d+)$/);
    if (repository && prMatch) return this.prs[`${repository}#${prMatch[1]}`];

    if (repository && suffix.includes('/check-runs')) return { check_runs: [] };
    if (repository && suffix.includes('/check-suites')) return { check_suites: [] };
    if (repository && suffix === '/actions/runs') return { workflow_runs: [] };
    if (repository && suffix.endsWith('/statuses')) return [];
    throw new Error(`Unexpected fake GitHub endpoint: ${endpoint}`);
  }
}

async function poll(context, client, observedAt = at(0), overrides = {}) {
  return pollRegisteredGitHubProjects({
    registry: context.registry,
    pollingStore: context.polling,
    ingressStore: context.ingress,
    client,
    observedAt,
    overlapMs: 5 * 60_000,
    bootstrapLookbackMs: 30 * 24 * 60 * 60_000,
    ...overrides,
  });
}

test('bootstraps issues, open PRs and default branches for two registered repositories', () => fixture(async (context) => {
  const client = new FakeGitHubClient();
  const result = await poll(context, client);
  assert.equal(result.projectsInspected, 2);
  assert.equal(result.deliveriesInserted, 4);
  assert.equal(result.outcomes.find((item) => item.projectId === 'alpha').issuesObserved, 1);
  assert.equal(result.outcomes.find((item) => item.projectId === 'alpha').pullRequestsObserved, 1);
  assert.equal(context.ingress.listPending({ limit: 20 }).length, 4);
  assert.equal(context.polling.getCursor('alpha').lastDefaultSha, ALPHA_MAIN);
  assert.equal(context.polling.getCursor('beta').lastDefaultSha, BETA_MAIN);
  assert.equal(JSON.stringify(context.ingress.listPending()).includes('status:ready'), false);
}));

test('overlap replay is deduplicated and does not emit an unchanged default-branch event', () => fixture(async (context) => {
  const client = new FakeGitHubClient();
  await poll(context, client, at(0));
  const second = await poll(context, client, at(60_000));
  assert.equal(second.deliveriesInserted, 0);
  assert.equal(second.duplicateDeliveries, 2);
  assert.equal(context.ingress.listPending({ limit: 20 }).length, 4);
}));

test('observes a merged PR and a changed default branch as new deliveries', () => fixture(async (context) => {
  const client = new FakeGitHubClient();
  await poll(context, client, at(0));
  client.issues['Owner/Alpha'] = [prStub(2, at(120_000))];
  client.openPrs['Owner/Alpha'] = [];
  client.mainShas['Owner/Alpha'] = 'e'.repeat(40);
  client.prs['Owner/Alpha#2'] = pullRequest({
    updatedAt: at(120_000),
    state: 'closed',
    mergedAt: at(119_000),
    mergeSha: 'e'.repeat(40),
  });
  const result = await poll(context, client, at(120_000));
  assert.equal(result.deliveriesInserted, 2);
  const pending = context.ingress.listPending({ limit: 20 });
  assert.ok(pending.some((item) => item.pullRequestNumber === 2 && item.mergeSha === 'e'.repeat(40)));
  assert.ok(pending.some((item) => item.event.afterSha === 'e'.repeat(40)));
}));

test('provider failure does not advance the affected project cursor', () => fixture(async (context) => {
  const client = new FakeGitHubClient();
  client.failRepository = 'Owner/Alpha';
  const result = await poll(context, client);
  const alpha = result.outcomes.find((item) => item.projectId === 'alpha');
  const beta = result.outcomes.find((item) => item.projectId === 'beta');
  assert.equal(alpha.errorCode, 'provider-read-failed');
  assert.equal(context.polling.getCursor('alpha'), null);
  assert.equal(beta.errorCode, undefined);
  assert.ok(context.polling.getCursor('beta'));
}));

test('pagination limits fail closed without advancing the cursor', () => fixture(async (context) => {
  const client = new FakeGitHubClient();
  const result = await poll(context, client, at(0), { perPage: 1, maxPages: 1 });
  assert.equal(result.outcomes.find((item) => item.projectId === 'alpha').errorCode, 'github-poll-failed');
  assert.equal(context.polling.getCursor('alpha'), null);
}));

test('poll cursor and delivery deduplication survive process restart', () => fixture(async (context) => {
  const client = new FakeGitHubClient();
  await poll(context, client, at(0));
  context.polling.close();
  context.ingress.close();
  context.polling = new GitHubPollingStore(context.dbPath);
  context.ingress = new EventIngressStore(context.dbPath);
  const result = await poll(context, client, at(60_000));
  assert.equal(result.deliveriesInserted, 0);
  assert.equal(context.polling.getCursor('alpha').lastSuccessAt, at(60_000));
}));

test('combined polling/controller cycles produce durable one-time triage releases', () => fixture(async (context) => {
  const client = new FakeGitHubClient();
  client.issues['Owner/Alpha'] = [issue(9, at(0))];
  client.openPrs['Owner/Alpha'] = [];
  client.issues['Owner/Beta'] = [];
  const first = await runPollingControllerCycle({
    registry: context.registry,
    pollingStore: context.polling,
    ingressStore: context.ingress,
    settlementStore: context.settlement,
    releaseStore: context.releases,
    githubClient: client,
    observedAt: at(0),
    overlapMs: 0,
    debounceMs: 0,
    quietPeriodMs: 1_000,
    settlementTimeoutMs: 10_000,
  });
  assert.equal(first.controller.releasesCreated, 0);
  const second = await runPollingControllerCycle({
    registry: context.registry,
    pollingStore: context.polling,
    ingressStore: context.ingress,
    settlementStore: context.settlement,
    releaseStore: context.releases,
    githubClient: client,
    observedAt: at(1_000),
    overlapMs: 0,
    debounceMs: 0,
    quietPeriodMs: 1_000,
    settlementTimeoutMs: 10_000,
  });
  assert.ok(second.controller.releasesCreated >= 1);
  const releaseCount = context.releases.listReleases({ states: ['pending'], limit: 20 }).length;
  assert.ok(releaseCount >= 1);
  const third = await runPollingControllerCycle({
    registry: context.registry,
    pollingStore: context.polling,
    ingressStore: context.ingress,
    settlementStore: context.settlement,
    releaseStore: context.releases,
    githubClient: client,
    observedAt: at(2_000),
    overlapMs: 0,
    debounceMs: 0,
    quietPeriodMs: 1_000,
    settlementTimeoutMs: 10_000,
  });
  assert.equal(third.controller.releasesCreated, 0);
  assert.equal(context.releases.listReleases({ states: ['pending'], limit: 20 }).length, releaseCount);
}));
