import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EventControllerReleaseReader,
  EventControllerReleaseStore,
  runEventControllerCycle,
} from './agent-runner-event-controller.mjs';
import { acceptGitHubWebhook, EventIngressStore } from './agent-runner-event-ingress.mjs';
import { EventSettlementStore } from './agent-runner-event-settlement.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';

const SECRET = 'event-controller-fixture-secret-minimum-32-bytes';
const T0 = Date.parse('2026-07-29T03:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const HEAD_SHA = 'a'.repeat(40);

function projectConfig() {
  return {
    projectId: 'alpha',
    displayName: 'Alpha',
    githubRepo: 'Owner/Alpha',
    localRepoPath: '/srv/alpha',
    outputDir: '.var/agent-runner',
    stateDbPath: '.var/agent-runner/state.sqlite',
    acceptedAgentLabels: ['agent:claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: ['npm test'],
    systemd: { serviceName: 'alpha.service', timerName: 'alpha.timer' },
    runner: { lockPath: '.var/agent-runner/alpha.lock', candidateLimit: 10 },
  };
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-event-controller-'));
  const configPath = join(dir, 'alpha.json');
  const registryPath = join(dir, 'registry.json');
  const dbPath = join(dir, 'controller.sqlite');
  writeFileSync(configPath, JSON.stringify(projectConfig()));
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: ['alpha.json'] }));
  const context = {
    registry: loadProjectRegistry({ registryPath }),
    ingress: new EventIngressStore(dbPath),
    settlement: new EventSettlementStore(dbPath),
    releases: new EventControllerReleaseStore(dbPath),
    dbPath,
    dir,
  };
  try {
    return await fn(context);
  } finally {
    context.releases?.close();
    context.settlement?.close();
    context.ingress?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function deliver(context, payload, { deliveryId, eventName, receivedAt }) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return acceptGitHubWebhook({
    rawBody,
    headers: {
      'x-github-delivery': deliveryId,
      'x-github-event': eventName,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
    },
    secret: SECRET,
    registry: context.registry,
    store: context.ingress,
    receivedAt,
  });
}

function issuePayload(number = 9) {
  return {
    action: 'closed',
    repository: { full_name: 'Owner/Alpha', default_branch: 'main' },
    issue: { number },
  };
}

function prPayload(number = 7) {
  return {
    action: 'synchronize',
    repository: { full_name: 'Owner/Alpha', default_branch: 'main' },
    pull_request: {
      number,
      merged: false,
      head: { sha: HEAD_SHA, ref: `feature-${number}` },
      base: { sha: 'b'.repeat(40), ref: 'main' },
    },
  };
}

function githubClient(mode = () => 'success') {
  return {
    async requestJson(endpoint) {
      const current = mode(endpoint);
      if (current instanceof Error) throw current;
      if (endpoint.includes('/check-runs')) return { check_runs: [] };
      if (endpoint.includes('/check-suites')) return { check_suites: [] };
      if (endpoint.endsWith('/actions/runs')) {
        if (current === 'empty') return { workflow_runs: [] };
        return { workflow_runs: [{
          id: 1,
          name: 'Validate',
          status: current === 'pending' ? 'in_progress' : 'completed',
          conclusion: current === 'pending' ? null : 'success',
        }] };
      }
      if (endpoint.includes('/actions/runs/1/jobs')) {
        return { jobs: [{
          id: 10,
          name: 'validate',
          status: current === 'pending' ? 'queued' : 'completed',
          conclusion: current === 'pending' ? null : 'success',
        }] };
      }
      return [];
    },
  };
}

function cycle(context, options = {}) {
  return runEventControllerCycle({
    registry: context.registry,
    settlementStore: context.settlement,
    releaseStore: context.releases,
    githubClient: options.githubClient ?? githubClient(),
    now: options.now ?? at(0),
    debounceMs: options.debounceMs ?? 0,
    quietPeriodMs: options.quietPeriodMs ?? 1_000,
    settlementTimeoutMs: options.settlementTimeoutMs ?? 10_000,
  });
}

function controllerHashes(context) {
  return Object.fromEntries(
    readdirSync(context.dir)
      .filter((name) => name.startsWith('controller.sqlite'))
      .sort()
      .map((name) => [
        name,
        createHash('sha256').update(readFileSync(join(context.dir, name))).digest('hex'),
      ]),
  );
}

test('releases an issue-only batch exactly once after debounce and quiet period', () => fixture(async (context) => {
  deliver(context, issuePayload(), { deliveryId: 'issue-1', eventName: 'issues', receivedAt: at(0) });
  const first = await cycle(context, { now: at(0) });
  assert.equal(first.releasesCreated, 0);
  assert.equal(first.outcomes[0].state, 'quiet_period');
  const second = await cycle(context, { now: at(1_000) });
  assert.equal(second.releasesCreated, 1);
  assert.equal(second.outcomes[0].state, 'settled');
  assert.equal(context.releases.listReleases().length, 1);
  const third = await cycle(context, { now: at(2_000) });
  assert.equal(third.releasesCreated, 0);
  assert.equal(context.releases.listReleases().length, 1);
}));

test('waits for pending workflow and job evidence, then performs a final refresh before release', () => fixture(async (context) => {
  deliver(context, prPayload(), { deliveryId: 'pr-1', eventName: 'pull_request', receivedAt: at(0) });
  let mode = 'pending';
  const client = githubClient(() => mode);
  const waiting = await cycle(context, { now: at(0), githubClient: client });
  assert.equal(waiting.outcomes[0].state, 'waiting_for_checks');
  assert.equal(waiting.releasesCreated, 0);
  mode = 'success';
  const quiet = await cycle(context, { now: at(100), githubClient: client });
  assert.equal(quiet.outcomes[0].state, 'quiet_period');
  const settled = await cycle(context, { now: at(1_100), githubClient: client });
  assert.equal(settled.outcomes[0].state, 'settled');
  assert.equal(settled.releasesCreated, 1);
}));

test('a late-starting workflow resets the quiet-period settlement path', () => fixture(async (context) => {
  deliver(context, prPayload(), { deliveryId: 'pr-late', eventName: 'pull_request', receivedAt: at(0) });
  let mode = 'empty';
  const client = githubClient(() => mode);
  const quiet = await cycle(context, { now: at(0), githubClient: client });
  assert.equal(quiet.outcomes[0].state, 'quiet_period');
  mode = 'pending';
  const reset = await cycle(context, { now: at(1_000), githubClient: client });
  assert.equal(reset.outcomes[0].state, 'waiting_for_checks');
  assert.equal(reset.releasesCreated, 0);
}));

test('provider failure remains blocking and cannot create a triage release', () => fixture(async (context) => {
  deliver(context, prPayload(), { deliveryId: 'pr-provider-fail', eventName: 'pull_request', receivedAt: at(0) });
  const error = new Error('provider failed');
  error.code = 'provider-read-failed';
  const result = await cycle(context, {
    now: at(0),
    githubClient: githubClient(() => error),
  });
  assert.equal(result.outcomes[0].state, 'waiting_for_checks');
  assert.equal(result.releasesCreated, 0);
  assert.ok(result.outcomes[0].providerDiagnostics.length >= 1);
}));

test('a non-terminal batch reaches settlement_blocked without bypassing CI', () => fixture(async (context) => {
  deliver(context, prPayload(), { deliveryId: 'pr-timeout', eventName: 'pull_request', receivedAt: at(0) });
  const client = githubClient(() => 'pending');
  await cycle(context, { now: at(0), githubClient: client, settlementTimeoutMs: 1_000 });
  const blocked = await cycle(context, { now: at(1_000), githubClient: client, settlementTimeoutMs: 1_000 });
  assert.equal(blocked.outcomes[0].state, 'settlement_blocked');
  assert.equal(blocked.releasesCreated, 0);
}));

test('release claims are leased, recoverable and require the matching token to finish', () => fixture(async (context) => {
  deliver(context, issuePayload(12), { deliveryId: 'issue-claim', eventName: 'issues', receivedAt: at(0) });
  await cycle(context, { now: at(0) });
  await cycle(context, { now: at(1_000) });
  const [pending] = context.releases.listReleases();
  const token = 'claim-token-1234';
  const claimed = context.releases.claimRelease(pending.batchId, { claimToken: token, leaseMs: 1_000, now: at(1_100) });
  assert.equal(claimed.state, 'claimed');
  assert.equal(context.releases.claimRelease(pending.batchId, { claimToken: 'other-token-1234', now: at(1_200) }), null);
  assert.equal(context.releases.finishRelease(pending.batchId, { claimToken: 'wrong-token-1234', now: at(1_300) }), null);
  assert.equal(context.releases.requeueExpiredClaims({ now: at(2_100) }), 1);
  const reclaimed = context.releases.claimRelease(pending.batchId, { claimToken: token, now: at(2_200) });
  assert.equal(reclaimed.state, 'claimed');
  const completed = context.releases.finishRelease(pending.batchId, {
    claimToken: token,
    state: 'processed',
    result: { triage: 'complete' },
    now: at(2_300),
  });
  assert.equal(completed.state, 'processed');
  assert.deepEqual(completed.result, { triage: 'complete' });
}));

test('pending releases and batches survive process restart', () => fixture(async (context) => {
  deliver(context, issuePayload(13), { deliveryId: 'issue-restart', eventName: 'issues', receivedAt: at(0) });
  await cycle(context, { now: at(0) });
  await cycle(context, { now: at(1_000) });
  const batchId = context.releases.listReleases()[0].batchId;
  context.releases.close();
  context.settlement.close();
  context.releases = new EventControllerReleaseStore(context.dbPath);
  context.settlement = new EventSettlementStore(context.dbPath);
  assert.equal(context.releases.getRelease(batchId).state, 'pending');
  assert.equal(context.settlement.getBatch(batchId).state, 'settled');
  const duplicate = context.releases.releaseSettledBatch(context.settlement.getBatch(batchId), { now: at(2_000) });
  assert.equal(duplicate.inserted, false);
}));

test('read-only release snapshots preserve controller files and release state byte-for-byte', () => fixture(async (context) => {
  deliver(context, issuePayload(14), { deliveryId: 'issue-shadow-read', eventName: 'issues', receivedAt: at(0) });
  await cycle(context, { now: at(0) });
  await cycle(context, { now: at(1_000) });
  const [pending] = context.releases.listReleases();

  context.releases.close();
  context.settlement.close();
  context.ingress.close();
  context.releases = null;
  context.settlement = null;
  context.ingress = null;

  const before = controllerHashes(context);
  const reader = new EventControllerReleaseReader(context.dbPath);
  try {
    const snapshot = reader.getRelease(pending.batchId);
    assert.equal(snapshot.state, 'pending');
    assert.equal(reader.listReleases({ states: ['pending'], limit: 20 }).length, 1);
    assert.throws(() => reader.listReleases({ limit: 21 }), /1 to 20/);
  } finally {
    reader.close();
  }
  assert.deepEqual(controllerHashes(context), before);
}));
