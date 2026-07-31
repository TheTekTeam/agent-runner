import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeQueueTriageLocalAuthorityFingerprint,
  normalizeQueueTriageLocalAuthority,
  runQueueTriageLocalAuthorityCycle,
  parseClosedLoopOptions,
  runClosedLoopCycle,
} from './agent-runner-queue-triage-local-authority.mjs';

function authority(overrides = {}) {
  const input = {
    schemaVersion: 1,
    enabled: true,
    revision: 'AR113-LOCAL-AUTHORITY-TEST.1',
    sourceSha: 'a'.repeat(40),
    projectIds: ['agent-runner', 'modelspend'],
    maxReleasesPerCycle: 20,
    ...overrides,
  };
  input.fingerprint = computeQueueTriageLocalAuthorityFingerprint(input);
  return normalizeQueueTriageLocalAuthority(input);
}

function release(batchId, projectId, repository) {
  return Object.freeze({
    batchId,
    state: 'pending',
    releasedAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    payload: Object.freeze({ projectId, repository, objectKind: 'issue', objectNumber: 1 }),
    result: Object.freeze({}),
  });
}

function registry() {
  const projects = [
    { projectId: 'agent-runner', githubRepo: 'TheTekTeam/agent-runner', queueTriage: { enabled: true } },
    { projectId: 'modelspend', githubRepo: 'TheTekTeam/modelspend', queueTriage: { enabled: true } },
    { projectId: 'disabled', githubRepo: 'TheTekTeam/disabled', queueTriage: { enabled: false } },
  ];
  return { projects, projectsById: Object.fromEntries(projects.map((project) => [project.projectId, project])) };
}

test('normalizes a fingerprint-bound local authority', () => {
  const value = authority();
  assert.equal(value.fingerprint, computeQueueTriageLocalAuthorityFingerprint(value));
  assert.deepEqual(value.projectIds, ['agent-runner', 'modelspend']);
});

test('rejects changed authority content with a stale fingerprint', () => {
  const value = authority();
  assert.throws(() => normalizeQueueTriageLocalAuthority({ ...value, maxReleasesPerCycle: 19 }), /fingerprint mismatch/);
});

test('absence or disabled authority stays read-only without opening the ledger', () => {
  let opened = false;
  const result = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite',
    registry: registry(),
    authority: null,
    sourceSha: 'a'.repeat(40),
    execute: true,
    readerFactory() { opened = true; throw new Error('must not open'); },
  });
  assert.equal(result.status, 'disabled');
  assert.equal(opened, false);
  assert.equal(result.runControl.githubWritesPerformed, false);
});

test('processes eligible pending releases in durable order', () => {
  const seen = [];
  const releases = [
    release('batch-1', 'agent-runner', 'TheTekTeam/agent-runner'),
    release('batch-2', 'modelspend', 'TheTekTeam/modelspend'),
  ];
  const result = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite',
    registry: registry(),
    authority: authority(),
    sourceSha: 'a'.repeat(40),
    execute: true,
    fallbackPerformed: true,
    readerFactory: () => ({ listReleases: () => releases, close() {} }),
    executor({ releaseId }) {
      seen.push(releaseId);
      return { status: 'processed', runControl: { mutationsAttempted: 1, mutationsVerified: 1 } };
    },
    readClient: {},
    writeClient: {},
  });
  assert.deepEqual(seen, ['batch-1', 'batch-2']);
  assert.equal(result.status, 'completed');
  assert.equal(result.runControl.releasesProcessed, 2);
  assert.equal(result.runControl.mutationsVerified, 2);
  assert.equal(result.runControl.fallbackPerformed, true);
});

test('skips projects outside authority or without project opt-in', () => {
  const seen = [];
  const result = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite',
    registry: registry(),
    authority: authority({ projectIds: ['agent-runner'] }),
    sourceSha: 'a'.repeat(40),
    execute: true,
    readerFactory: () => ({
      listReleases: () => [
        release('batch-disabled', 'disabled', 'TheTekTeam/disabled'),
        release('batch-modelspend', 'modelspend', 'TheTekTeam/modelspend'),
        release('batch-agent', 'agent-runner', 'TheTekTeam/agent-runner'),
      ],
      close() {},
    }),
    executor({ releaseId }) {
      seen.push(releaseId);
      return { status: 'processed', runControl: { mutationsAttempted: 0, mutationsVerified: 0 } };
    },
    readClient: {},
    writeClient: {},
  });
  assert.deepEqual(seen, ['batch-agent']);
  assert.equal(result.runControl.releasesEligible, 1);
});

test('stops after the first failed execution', () => {
  const seen = [];
  const result = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite',
    registry: registry(),
    authority: authority(),
    sourceSha: 'a'.repeat(40),
    execute: true,
    readerFactory: () => ({
      listReleases: () => [
        release('batch-1', 'agent-runner', 'TheTekTeam/agent-runner'),
        release('batch-2', 'modelspend', 'TheTekTeam/modelspend'),
      ],
      close() {},
    }),
    executor({ releaseId }) {
      seen.push(releaseId);
      return { status: 'failed', runControl: { mutationsAttempted: 0, mutationsVerified: 0 } };
    },
    readClient: {},
    writeClient: {},
  });
  assert.deepEqual(seen, ['batch-1']);
  assert.equal(result.status, 'failed');
  assert.equal(result.runControl.releasesFailed, 1);
});

test('binds authority to the exact installed source SHA', () => {
  assert.throws(() => runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite',
    registry: registry(),
    authority: authority(),
    sourceSha: 'b'.repeat(40),
    execute: true,
  }), /source SHA mismatch/);
});

test('parses local-authority flags without forwarding them to polling', () => {
  const parsed = parseClosedLoopOptions([
    '--project-registry', '/tmp/projects.json',
    '--queue-triage-authority', '/tmp/authority.json',
    '--queue-triage-source-sha', 'a'.repeat(40),
    '--execute',
    '--batch-limit', '25',
  ], {});
  assert.equal(parsed.execute, true);
  assert.equal(parsed.authorityPath, '/tmp/authority.json');
  assert.deepEqual(parsed.pollingArgv, ['--project-registry', '/tmp/projects.json', '--batch-limit', '25']);
});

test('rejects unbounded queue aliases', () => {
  assert.throws(() => parseClosedLoopOptions(['--all-enabled'], {}), /unbounded/);
});

test('runs polling before triage and reports polling as fallback', async () => {
  const order = [];
  const result = await runClosedLoopCycle({
    argv: ['--project-registry', '/tmp/projects.json', '--db', '/tmp/controller.sqlite', '--execute'],
    env: {},
    observedAt: '2026-07-31T00:00:00.000Z',
    async runPolling() { order.push('polling'); return { schemaVersion: 1, observedAt: '2026-07-31T00:00:00.000Z' }; },
    parsePolling() { return { registryPath: '/tmp/projects.json', dbPath: '/tmp/controller.sqlite' }; },
    loadRegistry() { order.push('registry'); return { projects: [], projectsById: {} }; },
    loadAuthority() { order.push('authority'); return null; },
    runTriage(input) {
      order.push('triage');
      assert.equal(input.fallbackPerformed, true);
      return {
        status: 'disabled',
        runControl: { githubWritesPerformed: false, mutationsAttempted: 0, mutationsVerified: 0 },
      };
    },
    readClientFactory: () => ({}),
    writeClientFactory: () => ({}),
  });
  assert.deepEqual(order, ['polling', 'registry', 'authority', 'triage']);
  assert.equal(result.runControl.fallbackPerformed, true);
  assert.equal(result.runControl.githubWritesPerformed, false);
});

test('does not invoke triage when polling fails', async () => {
  let triageCalled = false;
  await assert.rejects(runClosedLoopCycle({
    argv: ['--project-registry', '/tmp/projects.json'],
    env: {},
    async runPolling() { throw new Error('polling failed'); },
    runTriage() { triageCalled = true; },
  }), /polling failed/);
  assert.equal(triageCalled, false);
});
