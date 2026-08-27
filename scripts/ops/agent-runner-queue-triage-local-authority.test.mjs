import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  QueueTriageLocalStateStore,
  computeQueueTriageLocalAuthorityFingerprint,
  listAuthorityPendingReleases,
  normalizeQueueTriageLocalAuthority,
  parseClosedLoopOptions,
  runClosedLoopCycle,
  runQueueTriageLocalAuthorityCycle,
  selectRotatingIssueNumbers,
} from './agent-runner-queue-triage-local-authority.mjs';

function authority(overrides = {}) {
  const input = {
    schemaVersion: 1,
    enabled: true,
    revision: 'AR113-LOCAL-AUTHORITY-TEST.2',
    sourceSha: 'a'.repeat(40),
    projectIds: ['agent-runner', 'modelspend'],
    maxReleasesPerCycle: 20,
    ...overrides,
  };
  input.fingerprint = computeQueueTriageLocalAuthorityFingerprint(input);
  return normalizeQueueTriageLocalAuthority(input);
}

function project(projectId, repository, overrides = {}) {
  return {
    projectId,
    githubRepo: repository,
    queueTriage: {
      enabled: true,
      maxMutations: 3,
      fallbackIntervalMinutes: 60,
      timezone: 'Europe/London',
      ...overrides,
    },
  };
}

function registry() {
  const projects = [
    project('agent-runner', 'TheTekTeam/agent-runner'),
    project('modelspend', 'TheTekTeam/modelspend'),
    project('disabled', 'TheTekTeam/disabled', { enabled: false }),
  ];
  return { projects, projectsById: Object.fromEntries(projects.map((value) => [value.projectId, value])) };
}

function release(batchId, projectId, repository, objectNumber = 1) {
  return Object.freeze({
    batchId,
    state: 'pending',
    releasedAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    payload: Object.freeze({ projectId, repository, objectKind: 'issue', objectNumber }),
    result: Object.freeze({}),
  });
}

function memoryStateStore(initial = {}) {
  const states = new Map(Object.entries(initial));
  const fallbacks = new Map();
  return {
    states,
    fallbacks,
    getProjectState(projectId) {
      return states.get(projectId) ?? {
        projectId, lastSuccessAt: null, lastFallbackId: null, rotatingCursor: 0, updatedAt: null,
      };
    },
    markProjectSuccess(projectId, { now, rotatingCursor, fallbackId = null }) {
      states.set(projectId, {
        projectId,
        lastSuccessAt: now,
        lastFallbackId: fallbackId,
        rotatingCursor,
        updatedAt: now,
      });
    },
    beginFallback(fallbackId, projectId) {
      if (fallbacks.has(fallbackId)) return { inserted: false, state: fallbacks.get(fallbackId).state, result: fallbacks.get(fallbackId) };
      fallbacks.set(fallbackId, { state: 'running', projectId });
      return { inserted: true, state: 'running', result: null };
    },
    finishFallback(fallbackId, state, result) {
      fallbacks.set(fallbackId, { state, result });
      return { state, result, fingerprint: `sha256:${'f'.repeat(64)}` };
    },
    recordException() {},
    close() {},
  };
}

const NO_RELEASE_READER = () => ({ close() {} });
const NO_RELEASE_SELECTOR = () => [];
const NO_ROTATION = () => ({ numbers: Object.freeze([]), nextCursor: 0, hourKey: '2026-07-31T00' });

test('normalizes a fingerprint-bound local authority', () => {
  const value = authority();
  assert.equal(value.fingerprint, computeQueueTriageLocalAuthorityFingerprint(value));
  assert.deepEqual(value.projectIds, ['agent-runner', 'modelspend']);
});

test('rejects changed authority content with a stale fingerprint', () => {
  const value = authority();
  assert.throws(() => normalizeQueueTriageLocalAuthority({ ...value, maxReleasesPerCycle: 19 }), /fingerprint mismatch/);
});

test('absence of authority stays read-only without opening local or controller state', () => {
  let opened = false;
  const result = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite',
    localStateDb: '/tmp/local.sqlite',
    registry: registry(),
    authority: null,
    sourceSha: 'a'.repeat(40),
    execute: true, allEnabled: true,
    readerFactory() { opened = true; throw new Error('must not open'); },
    stateStoreFactory() { opened = true; throw new Error('must not open'); },
  });
  assert.equal(result.status, 'disabled');
  assert.equal(opened, false);
  assert.equal(result.runControl.pendingSweepPerformed, false);
  assert.equal(result.runControl.fallbackPerformed, false);
});

test('binds authority to exact source and enabled project configuration via bounded read-only fallback', () => {
  const staleSource = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite', localStateDb: '/tmp/local.sqlite', registry: registry(),
    authority: authority(), sourceSha: 'b'.repeat(40), execute: true, allEnabled: true,
  });
  assert.equal(staleSource.status, 'read-only');
  assert.equal(staleSource.reasonCode, 'queue-triage-authority-source-sha-stale');
  assert.equal(staleSource.runControl.mutationsAttempted, 0);
  assert.equal(staleSource.runControl.githubWritesPerformed, false);

  const bad = registry();
  bad.projectsById.modelspend.queueTriage.enabled = false;
  const mismatch = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite', localStateDb: '/tmp/local.sqlite', registry: bad,
    authority: authority(), sourceSha: 'a'.repeat(40), execute: true, allEnabled: true,
  });
  assert.equal(mismatch.status, 'read-only');
  assert.equal(mismatch.reasonCode, 'queue-triage-authority-project-opt-in-mismatch');
  assert.equal(mismatch.runControl.mutationsAttempted, 0);
});

test('authority release selector filters in SQL and preserves fair project rank ordering', () => {
  let sql = '';
  let args = [];
  const reader = {
    db: {
      prepare(value) {
        sql = value;
        return { all(...values) { args = values; return [{ batch_id: 'batch-a' }, { batch_id: 'batch-b' }]; } };
      },
    },
    getRelease(batchId) { return { batchId }; },
  };
  const result = listAuthorityPendingReleases(reader, ['modelspend', 'agent-runner'], 20);
  assert.deepEqual(result.map((item) => item.batchId), ['batch-a', 'batch-b']);
  assert.match(sql, /ROW_NUMBER\(\) OVER/);
  assert.match(sql, /json_extract\(payload_json, '\$\.projectId'\)/);
  assert.deepEqual(args, ['agent-runner', 'modelspend', 20]);
});

test('selects two open issues in number order, wraps by cursor and excludes changed items', () => {
  const client = {
    requestJson() {
      return [
        { number: 12, state: 'open' },
        { number: 5, state: 'open' },
        { number: 8, state: 'open', pull_request: {} },
        { number: 9, state: 'open' },
      ];
    },
  };
  const selected = selectRotatingIssueNumbers({
    client,
    project: project('agent-runner', 'TheTekTeam/agent-runner'),
    observedAt: '2026-07-31T12:00:00.000Z',
    cursor: 9,
    excludedNumbers: [5],
  });
  assert.deepEqual(selected.numbers, [12, 9]);
  assert.equal(selected.nextCursor, 9);
});

test('processes eligible releases in order with rotating evidence and mutation budget', () => {
  const seen = [];
  const store = memoryStateStore();
  const releases = [
    release('batch-1', 'agent-runner', 'TheTekTeam/agent-runner', 101),
    release('batch-2', 'agent-runner', 'TheTekTeam/agent-runner', 102),
    release('batch-3', 'modelspend', 'TheTekTeam/modelspend', 201),
  ];
  const result = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite',
    localStateDb: '/tmp/local.sqlite',
    registry: registry(),
    authority: authority(),
    sourceSha: 'a'.repeat(40),
    execute: true, allEnabled: true,
    observedAt: '2026-07-31T12:00:00.000Z',
    readerFactory: NO_RELEASE_READER,
    releaseSelector: () => releases,
    stateStoreFactory: () => store,
    rotationSelector: ({ project: value }) => ({ numbers: [value.projectId === 'agent-runner' ? 11 : 21], nextCursor: 11, hourKey: '2026-07-31T13' }),
    executor({ releaseId, project: value, collectEvidence }) {
      seen.push({ releaseId, budget: value.queueTriage.maxMutations, collector: typeof collectEvidence });
      return { status: 'processed', runControl: { mutationsAttempted: releaseId === 'batch-1' ? 3 : 0, mutationsVerified: releaseId === 'batch-1' ? 3 : 0 } };
    },
    fallbackExecutor() { throw new Error('successful releases postpone fallback'); },
    readClient: {},
    writeClient: {},
    baseCollector: () => ({ changedItems: [{}], liveEvidence: { queryComplete: true, diagnostics: [] } }),
  });
  assert.deepEqual(seen, [
    { releaseId: 'batch-1', budget: 3, collector: 'function' },
    { releaseId: 'batch-3', budget: 3, collector: 'function' },
  ]);
  assert.equal(result.runControl.releasesInspected, 3);
  assert.equal(result.runControl.releasesProcessed, 2);
  assert.equal(result.runControl.mutationsVerified, 3);
  assert.equal(result.runControl.fallbackPerformed, false);
});

test('stops release processing after the first failed terminal result', () => {
  const seen = [];
  const result = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite', localStateDb: '/tmp/local.sqlite', registry: registry(),
    authority: authority(), sourceSha: 'a'.repeat(40), execute: true, allEnabled: true,
    readerFactory: NO_RELEASE_READER,
    releaseSelector: () => [
      release('batch-1', 'agent-runner', 'TheTekTeam/agent-runner'),
      release('batch-2', 'modelspend', 'TheTekTeam/modelspend'),
    ],
    stateStoreFactory: () => memoryStateStore(),
    rotationSelector: NO_ROTATION,
    executor({ releaseId }) {
      seen.push(releaseId);
      return { status: 'failed', runControl: { mutationsAttempted: 0, mutationsVerified: 0 } };
    },
    readClient: {}, writeClient: {},
  });
  assert.deepEqual(seen, ['batch-1']);
  assert.equal(result.status, 'failed');
  assert.equal(result.runControl.releasesFailed, 1);
});

test('runs an hourly fallback only when due and persists the rotating cursor', () => {
  const store = memoryStateStore({
    modelspend: {
      projectId: 'modelspend', lastSuccessAt: '2026-07-31T11:30:00.000Z', lastFallbackId: null,
      rotatingCursor: 0, updatedAt: '2026-07-31T11:30:00.000Z',
    },
  });
  const seen = [];
  const result = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite', localStateDb: '/tmp/local.sqlite', registry: registry(),
    authority: authority(), sourceSha: 'a'.repeat(40), execute: true, allEnabled: true,
    observedAt: '2026-07-31T12:45:00.000Z',
    readerFactory: NO_RELEASE_READER,
    releaseSelector: NO_RELEASE_SELECTOR,
    stateStoreFactory: () => store,
    rotationSelector: ({ project: value }) => ({
      numbers: value.projectId === 'agent-runner' ? [10, 20] : [30, 40],
      nextCursor: value.projectId === 'agent-runner' ? 20 : 40,
      hourKey: '2026-07-31T13',
    }),
    fallbackExecutor({ project: value, issueNumber }) {
      seen.push(`${value.projectId}#${issueNumber}`);
      return {
        batchId: `fallback-${issueNumber}`, projectId: value.projectId, repository: value.githubRepo,
        objectKind: 'issue', objectNumber: issueNumber, status: 'processed',
        mutationsAttempted: 0, mutationsVerified: 0, rotatingIssueNumbers: [],
      };
    },
    readClient: {}, writeClient: {},
  });
  assert.deepEqual(seen, ['agent-runner#10', 'agent-runner#20', 'modelspend#30', 'modelspend#40']);
  assert.equal(result.runControl.fallbackPerformed, true);
  assert.equal(result.runControl.fallbackProjects, 2);
  assert.equal(store.getProjectState('agent-runner').rotatingCursor, 20);
  assert.equal(store.getProjectState('modelspend').rotatingCursor, 40);
});

test('stops all later fallback work after the first failure', () => {
  const seen = [];
  const result = runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite', localStateDb: '/tmp/local.sqlite', registry: registry(),
    authority: authority(), sourceSha: 'a'.repeat(40), execute: true, allEnabled: true,
    observedAt: '2026-07-31T12:45:00.000Z',
    readerFactory: NO_RELEASE_READER, releaseSelector: NO_RELEASE_SELECTOR,
    stateStoreFactory: () => memoryStateStore(),
    rotationSelector: () => ({ numbers: [10, 20], nextCursor: 20, hourKey: '2026-07-31T13' }),
    fallbackExecutor({ project: value, issueNumber }) {
      seen.push(`${value.projectId}#${issueNumber}`);
      return {
        batchId: `fallback-${issueNumber}`, projectId: value.projectId, repository: value.githubRepo,
        objectKind: 'issue', objectNumber: issueNumber, status: 'failed',
        mutationsAttempted: 0, mutationsVerified: 0, rotatingIssueNumbers: [],
      };
    },
    readClient: {}, writeClient: {},
  });
  assert.deepEqual(seen, ['agent-runner#10']);
  assert.equal(result.status, 'failed');
  assert.equal(result.runControl.fallbackProjects, 1);
});

test('local fallback state survives close and reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'queue-triage-state-test-'));
  const path = join(directory, 'state.sqlite');
  try {
    let store = new QueueTriageLocalStateStore(path, { now: () => '2026-07-31T12:00:00.000Z' });
    store.markProjectSuccess('agent-runner', { rotatingCursor: 42, fallbackId: 'fallback:agent-runner:2026-07-31T13' });
    assert.equal(store.beginFallback('fallback:test', 'agent-runner').inserted, true);
    store.finishFallback('fallback:test', 'processed', { schemaVersion: 1, status: 'processed' });
    store.close();
    store = new QueueTriageLocalStateStore(path);
    assert.equal(store.getProjectState('agent-runner').rotatingCursor, 42);
    assert.equal(store.beginFallback('fallback:test', 'agent-runner').state, 'processed');
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parses local authority inputs without forwarding them to polling', () => {
  const parsed = parseClosedLoopOptions([
    '--project-registry', '/tmp/projects.json',
    '--queue-triage-authority', '/tmp/authority.json',
    '--queue-triage-source-sha', 'a'.repeat(40),
    '--queue-triage-state-db', '/tmp/triage.sqlite',
    '--all-enabled', '--execute', '--batch-limit', '25',
  ], {});
  assert.equal(parsed.execute, true);
  assert.equal(parsed.allEnabled, true);
  assert.equal(parsed.authorityPath, '/tmp/authority.json');
  assert.equal(parsed.localStateDb, '/tmp/triage.sqlite');
  assert.deepEqual(parsed.pollingArgv, ['--project-registry', '/tmp/projects.json', '--batch-limit', '25']);
  assert.throws(() => parseClosedLoopOptions(['--pending'], {}), /unbounded/);
  assert.throws(() => parseClosedLoopOptions(['--fallback'], {}), /requires --all-enabled/);
  assert.equal(parseClosedLoopOptions(['--all-enabled', '--fallback'], {}).forceFallback, true);
});

test('runs polling before triage and reports actual fallback status', async () => {
  const order = [];
  const result = await runClosedLoopCycle({
    argv: ['--project-registry', '/tmp/projects.json', '--db', '/tmp/controller.sqlite', '--all-enabled', '--execute'],
    env: {}, observedAt: '2026-07-31T00:00:00.000Z',
    async runPolling() { order.push('polling'); return { schemaVersion: 1 }; },
    parsePolling() { return { registryPath: '/tmp/projects.json', dbPath: '/tmp/controller.sqlite' }; },
    loadRegistry() { order.push('registry'); return { projects: [], projectsById: {} }; },
    loadAuthority() { order.push('authority'); return null; },
    runTriage() {
      order.push('triage');
      return {
        status: 'disabled',
        runControl: { fallbackPerformed: false, githubWritesPerformed: false, mutationsAttempted: 0, mutationsVerified: 0 },
      };
    },
    readClientFactory: () => ({}), writeClientFactory: () => ({}),
  });
  assert.deepEqual(order, ['polling', 'registry', 'authority', 'triage']);
  assert.equal(result.runControl.fallbackPerformed, false);
});

test('malformed local authority becomes a bounded read-only fallback after successful polling', async () => {
  let triageCalled = false;
  const result = await runClosedLoopCycle({
    argv: ['--project-registry', '/tmp/projects.json', '--db', '/tmp/controller.sqlite', '--all-enabled', '--execute'],
    env: {}, observedAt: '2026-07-31T00:00:00.000Z',
    async runPolling() { return { schemaVersion: 1 }; },
    parsePolling() { return { registryPath: '/tmp/projects.json', dbPath: '/tmp/controller.sqlite' }; },
    loadRegistry() { return { projects: [], projectsById: {} }; },
    loadAuthority() { throw new Error('invalid queue-triage local authority JSON'); },
    runTriage() { triageCalled = true; return {}; },
    readClientFactory: () => ({}), writeClientFactory: () => ({}),
  });
  assert.equal(triageCalled, false);
  assert.equal(result.triage.status, 'read-only');
  assert.equal(result.triage.reasonCode, 'queue-triage-authority-load-failed');
  assert.equal(result.runControl.githubWritesPerformed, false);
  assert.equal(result.runControl.mutationsAttempted, 0);
});

test('does not invoke triage when polling fails', async () => {
  let triageCalled = false;
  await assert.rejects(runClosedLoopCycle({
    argv: ['--project-registry', '/tmp/projects.json'], env: {},
    async runPolling() { throw new Error('polling failed'); },
    runTriage() { triageCalled = true; },
  }), /polling failed/);
  assert.equal(triageCalled, false);
});

test('requires --all-enabled for mutating local-authority execution', () => {
  assert.throws(() => runQueueTriageLocalAuthorityCycle({
    controllerDb: '/tmp/controller.sqlite', localStateDb: '/tmp/local.sqlite', registry: registry(),
    authority: authority(), sourceSha: 'a'.repeat(40), execute: true,
  }), /--all-enabled is required/);
});

test('recovers only a stale running fallback identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'queue-triage-recovery-test-'));
  const path = join(directory, 'state.sqlite');
  try {
    let now = '2026-07-31T12:00:00.000Z';
    const store = new QueueTriageLocalStateStore(path, { now: () => now });
    assert.equal(store.beginFallback('fallback:recovery', 'agent-runner').inserted, true);
    now = '2026-07-31T12:10:00.000Z';
    assert.equal(store.beginFallback('fallback:recovery', 'agent-runner').inserted, false);
    now = '2026-07-31T12:21:00.000Z';
    const recovered = store.beginFallback('fallback:recovery', 'agent-runner');
    assert.equal(recovered.inserted, true);
    assert.equal(recovered.recovered, true);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects an incompatible local state schema before migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'queue-triage-schema-test-'));
  const path = join(directory, 'state.sqlite');
  try {
    const bootstrap = new DatabaseSync(path);
    bootstrap.exec(`
      CREATE TABLE queue_triage_local_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO queue_triage_local_schema(version, applied_at) VALUES (2, '2026-07-31T00:00:00.000Z');
    `);
    bootstrap.close();
    assert.throws(() => new QueueTriageLocalStateStore(path), /unsupported local queue-triage state schema version/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
