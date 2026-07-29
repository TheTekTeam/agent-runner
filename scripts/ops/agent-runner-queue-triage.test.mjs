import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORE_QUEUE_TRIAGE_LIMITS,
  generateOpenAIOversightPrompt,
  normalizeQueueTriagePolicy,
  planQueueTriageRun,
} from './agent-runner-queue-triage.mjs';

function project(overrides = {}) {
  return {
    projectId: 'alpha',
    repository: 'Owner/Alpha',
    acceptedAgentLabels: ['agent:claude', 'agent:codex-claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress', blocked: 'status:blocked', done: 'status:done' },
    priorityLabels: ['priority:P0', 'priority:P1'],
    policy: { enabled: true, ...overrides },
  };
}

function item(overrides = {}) {
  return {
    repository: 'Owner/Alpha',
    kind: 'issue',
    number: 7,
    updatedAt: '2026-07-29T18:00:00Z',
    labels: ['priority:P0', 'status:ready', 'status:blocked', 'agent:claude'],
    evidenceRefs: ['issue:7', 'comment:22'],
    intendedStatus: 'status:blocked',
    flags: { explicitHold: true },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    project: project(),
    observedAt: '2026-07-29T18:05:00Z',
    mode: 'release',
    releaseId: 'release-1',
    changedItems: [item()],
    rotatingItems: [],
    ...overrides,
  };
}

test('queue triage policy defaults disabled and cannot widen core ceilings', () => {
  const policy = normalizeQueueTriagePolicy();
  assert.equal(policy.enabled, false);
  assert.equal(policy.maxChangedItems, CORE_QUEUE_TRIAGE_LIMITS.maxChangedItems);
  assert.throws(() => normalizeQueueTriagePolicy({ maxMutations: 4 }), /maxMutations/);
  assert.throws(() => normalizeQueueTriagePolicy({ rotatingBacklogSlice: 3 }), /rotatingBacklogSlice/);
  assert.throws(() => normalizeQueueTriagePolicy({ fallbackIntervalMinutes: 30 }), /fallbackIntervalMinutes/);
});

test('creates an immutable full-label replacement with deterministic evidence identity', () => {
  const first = planQueueTriageRun(run());
  const second = planQueueTriageRun(run());
  assert.equal(first.dryRun, true);
  assert.equal(first.runControl.mutationAllowed, false);
  assert.equal(first.actionPlans.length, 1);
  assert.deepEqual(first.actionPlans[0].intendedFullLabelSet, ['agent:claude', 'priority:P0', 'status:blocked']);
  assert.equal(first.actionPlans[0].idempotencyKey, second.actionPlans[0].idempotencyKey);
  assert.equal(first.actionPlans[0].evidenceFingerprint, second.actionPlans[0].evidenceFingerprint);
  assert.equal(first.actionPlans[0].authority, null);
  assert.equal(Object.isFrozen(first.actionPlans[0]), true);
});

test('raw or sensitive evidence fields are rejected before reporting', () => {
  assert.throws(() => planQueueTriageRun(run({ changedItems: [item({ body: 'raw issue body' })] })), /forbidden raw or sensitive/);
});

test('active ownership suppresses mutation and creates a typed exception', () => {
  const report = planQueueTriageRun(run({ changedItems: [item({ flags: { explicitHold: true, activeClaim: true } })] }));
  assert.equal(report.actionPlans.length, 0);
  assert.equal(report.exceptions.length, 1);
  assert.equal(report.exceptions[0].category, 'active-implementation-or-recovery');
  assert.equal(report.exceptions[0].code, 'activeClaim');
});

test('incomplete dependency cannot be cleared to ready', () => {
  const report = planQueueTriageRun(run({
    changedItems: [item({
      labels: ['priority:P0', 'status:blocked', 'agent:claude'],
      intendedStatus: 'status:ready',
      flags: {},
      dependencies: [{ id: 'Owner/Alpha#2', complete: false }],
    })],
  }));
  assert.equal(report.actionPlans.length, 0);
  assert.equal(report.exceptions[0].category, 'genuine-dependency-blocker');
});

test('two materially different repositories use the same planner without source branching', () => {
  const alpha = planQueueTriageRun(run());
  const beta = planQueueTriageRun({
    ...run(),
    project: {
      ...project({ maxMutations: 1, maxChangedItems: 5 }),
      projectId: 'beta',
      repository: 'Elsewhere/Beta',
      acceptedAgentLabels: ['agent:local'],
    },
    releaseId: 'release-beta',
    changedItems: [item({
      repository: 'Elsewhere/Beta',
      number: 44,
      labels: ['priority:P1', 'status:blocked', 'agent:local'],
      intendedStatus: 'status:ready',
      flags: {},
      dependencies: [{ id: 'Elsewhere/Beta#3', complete: true }],
    })],
  });
  assert.equal(alpha.actionPlans[0].projectId, 'alpha');
  assert.equal(beta.actionPlans[0].projectId, 'beta');
  assert.equal(beta.actionPlans[0].action, 'replace_labels');
});

test('count scopes remain distinct and bounded overflow is explicit', () => {
  const changedItems = Array.from({ length: 22 }, (_, index) => item({ number: index + 1, githubReady: index < 3 }));
  const report = planQueueTriageRun(run({ changedItems }));
  assert.equal(report.inspected.changed, 20);
  assert.equal(report.overflow.changedItems, 2);
  assert.equal(report.counts.inspectedScopeGitHubReady.count, 3);
  assert.equal(report.counts.repositoryWideReadyLabelled.state, 'not_calculated');
  assert.equal(report.counts.runtimeRunnableConfirmed.state, 'not_proven');
});

test('OpenAI oversight prompt is deterministic and derives limits from core constants', () => {
  const first = generateOpenAIOversightPrompt();
  const second = generateOpenAIOversightPrompt();
  assert.equal(first, second);
  assert.match(first, new RegExp(`at most ${CORE_QUEUE_TRIAGE_LIMITS.maxChangedItems} changed items`));
  assert.match(first, /do not duplicate deterministic mutations/i);
});
