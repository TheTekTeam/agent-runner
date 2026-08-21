import assert from 'node:assert/strict';
import test from 'node:test';

import { curateManagerQueue } from './agent-runner-manager-queue-curator.mjs';
import {
  applyQueueMutationTransaction,
  MANAGER_QUEUE_MUTATION_SCHEMA_VERSION,
  planQueueMutationTransaction,
  QUEUE_CURATION_MARKER,
  QUEUE_DEPENDENCY_BLOCK_END,
  QUEUE_DEPENDENCY_BLOCK_START,
  QUEUE_MUTATION_KINDS,
  renderQueueDependencyBlock,
  renderQueueIssueBody,
  serializeQueueMutationTransaction,
} from './agent-runner-manager-queue-mutation.mjs';
import {
  buildChain,
  buildQueueEvidence,
  HEAD_SHA,
  LABELS,
  OTHER_SOURCE_SHA,
  SOURCE_SHA,
} from './agent-runner-manager-queue-test-fixtures.mjs';

const EVIDENCE_KEY = 'qc:fixture-project:evidence-contract';
const CURATOR_KEY = 'qc:fixture-project:curator-transition';

function curationFor({ profileOverrides = {}, queueOverrides = {} } = {}) {
  const { proposal } = buildChain({ profileOverrides });
  return curateManagerQueue(buildQueueEvidence(proposal, queueOverrides));
}

function settledIssues() {
  return [
    { number: 10, title: 'Bounded queue evidence contract', state: 'open', labels: [LABELS.ready], curationKey: EVIDENCE_KEY, dependsOn: [] },
    { number: 11, title: 'Deterministic curation transition', state: 'open', labels: [LABELS.blocked], curationKey: CURATOR_KEY, dependsOn: [10] },
  ];
}

/**
 * A deterministic in-memory stand-in for the mutation port. It records every
 * call so a test can prove exactly which writes a transaction performed -- and
 * that nothing else (no provider, no dispatch, no scheduler) was reached.
 */
function recordingClient({ failOn = null, createReturns = (index) => ({ number: 100 + index }) } = {}) {
  const calls = [];
  let created = 0;
  const guard = (kind, request) => {
    calls.push({ kind, ...request });
    if (failOn === kind) {
      const error = new Error('write rejected');
      error.code = 'provider-write-forbidden';
      throw error;
    }
  };
  return {
    calls,
    createIssue(request) {
      guard('create-issue', request);
      const response = createReturns(created);
      created += 1;
      return response;
    },
    updateIssueLabels(request) {
      guard('update-labels', request);
      return { ok: true };
    },
    updateIssueDependencies(request) {
      guard('update-dependencies', request);
      return { ok: true };
    },
  };
}

test('a dry-run curation validates into an applyable transaction bound to the registered repository', () => {
  const transaction = planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA });
  assert.equal(transaction.schemaVersion, MANAGER_QUEUE_MUTATION_SCHEMA_VERSION);
  assert.equal(transaction.attribution.repository, 'FixtureOrg/fixture-repo');
  assert.equal(transaction.attribution.sourceSha, SOURCE_SHA);
  assert.match(transaction.attribution.curationRevision, /^qcr:[0-9a-f]{32}$/);
  assert.equal(transaction.operations.length, 2);
  for (const operation of transaction.operations) {
    assert.ok(QUEUE_MUTATION_KINDS.includes(operation.kind));
    assert.equal(operation.endpoint, '/repos/FixtureOrg/fixture-repo/issues');
  }
});

test('an update operation targets the exact allowlisted issue endpoint', () => {
  const issues = settledIssues();
  issues[0].labels = [LABELS.blocked];
  const transaction = planQueueMutationTransaction(curationFor({ queueOverrides: { issues } }), { currentSourceSha: SOURCE_SHA });
  assert.equal(transaction.operations.length, 1);
  assert.equal(transaction.operations[0].endpoint, '/repos/FixtureOrg/fixture-repo/issues/10');
  assert.deepEqual(transaction.operations[0].request, { labels: [LABELS.ready] });
});

test('a rendered issue body is deterministic, marked and free of executable content', () => {
  const transaction = planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA });
  const create = transaction.operations.find((operation) => operation.curationKey === EVIDENCE_KEY);
  const body = create.request.body;
  assert.ok(body.startsWith(QUEUE_CURATION_MARKER));
  assert.match(body, /<!-- agent-runner:queue-curation-key: qc:fixture-project:evidence-contract -->/);
  assert.match(body, /<!-- agent-runner:queue-curation-revision: qcr:[0-9a-f]{32} -->/);
  assert.ok(body.includes(QUEUE_DEPENDENCY_BLOCK_START));
  assert.ok(body.includes(QUEUE_DEPENDENCY_BLOCK_END));
  assert.doesNotMatch(body, /\$\(/);
  assert.doesNotMatch(body, /`/);
  assert.doesNotMatch(body, /<script/i);
  assert.equal(body, renderQueueIssueBody(
    curationFor().operations.find((operation) => operation.curationKey === EVIDENCE_KEY).bodySections,
    { curationRevision: transaction.attribution.curationRevision },
  ));
});

test('the managed dependency block is delimited and lists only issue references', () => {
  assert.equal(renderQueueDependencyBlock([]), [
    QUEUE_DEPENDENCY_BLOCK_START, '## Depends on', '', '- none', QUEUE_DEPENDENCY_BLOCK_END,
  ].join('\n'));
  assert.equal(renderQueueDependencyBlock([4, 9]), [
    QUEUE_DEPENDENCY_BLOCK_START, '## Depends on', '', '- #4', '- #9', QUEUE_DEPENDENCY_BLOCK_END,
  ].join('\n'));
});

test('a mutation count over the manager profile bound is refused before any write', () => {
  assert.throws(
    () => planQueueMutationTransaction(curationFor({
      profileOverrides: { mutationBounds: { maxIssueMutationsPerRecurrence: 1, maxCommentsPerRecurrence: 1 } },
    }), { currentSourceSha: SOURCE_SHA }),
    /Refusing agent runner queue mutation transaction: curation proposes 2 issue mutations, exceeding the manager profile bound of 1 per recurrence/,
  );
});

test('a profile without issue mutation authority is refused', () => {
  assert.throws(
    () => planQueueMutationTransaction(curationFor({
      profileOverrides: {
        mutationAuthority: {
          issueMutation: false,
          authorityIssuance: true,
          merge: false,
          close: false,
          deploy: false,
          sourceActivation: false,
        },
      },
    }), { currentSourceSha: SOURCE_SHA }),
    /manager profile does not authorise issue mutation/,
  );
});

test('a source revision that has drifted since the evidence was taken is refused', () => {
  assert.throws(
    () => planQueueMutationTransaction(curationFor(), { currentSourceSha: OTHER_SOURCE_SHA }),
    /curation was computed at source revision '[0-9a-f]{40}' but the current source revision is '[0-9a-f]{40}'/,
  );
  assert.throws(
    () => planQueueMutationTransaction(curationFor(), { currentSourceSha: 'not-a-sha' }),
    /currentSourceSha is required and must be a 40-character hex commit SHA/,
  );
  assert.throws(
    () => planQueueMutationTransaction(curationFor()),
    /currentSourceSha is required and must be a 40-character hex commit SHA/,
  );
  assert.doesNotThrow(() => planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA }));
});

test('only the profile queue labels the curator may set ever reach a mutation', () => {
  const transaction = planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA });
  const serialized = serializeQueueMutationTransaction(transaction);
  assert.ok(!serialized.includes(LABELS.inProgress));
  assert.ok(!serialized.includes(LABELS.done));
  for (const operation of transaction.operations) {
    for (const label of operation.request.labels ?? []) {
      assert.ok([LABELS.ready, LABELS.blocked].includes(label));
    }
  }
});

test('a transaction cannot be planned from a forged curation', () => {
  const curation = curationFor();
  assert.throws(() => planQueueMutationTransaction({ ...curation }, { currentSourceSha: SOURCE_SHA }), /was not produced by curateManagerQueue/);
});

test('apply is exactly the dry-run: same operations, same order, nothing extra', () => {
  const curation = curationFor();
  const transaction = planQueueMutationTransaction(curation, { currentSourceSha: SOURCE_SHA });
  const client = recordingClient();
  const result = applyQueueMutationTransaction(transaction, { client });

  assert.equal(result.status, 'applied');
  assert.equal(result.parity.matchesDryRun, true);
  assert.equal(result.parity.plannedOperationCount, 2);
  assert.equal(result.parity.appliedOperationCount, 2);
  assert.equal(result.parity.curationFingerprint, curation.curationFingerprint);
  assert.deepEqual(client.calls.map((call) => call.kind), ['create-issue', 'create-issue']);
  assert.deepEqual(client.calls.map((call) => call.curationKey), [CURATOR_KEY, EVIDENCE_KEY]);
  assert.deepEqual(result.appliedOperations.map((operation) => operation.issueNumber), [100, 101]);
  assert.deepEqual(result.pendingOperations, []);
  assert.equal(result.failure, null);
  assert.equal(result.outcome.successorHint, 'execution-reconcile-required');
  for (const call of client.calls) {
    assert.equal(call.attribution.curationFingerprint, curation.curationFingerprint);
    assert.equal(call.attribution.sourceSha, SOURCE_SHA);
  }
});

test('an already-settled queue applies as a no-op and never calls the mutation port', () => {
  const transaction = planQueueMutationTransaction(curationFor({ queueOverrides: { issues: settledIssues() } }), { currentSourceSha: SOURCE_SHA });
  const client = recordingClient();
  const result = applyQueueMutationTransaction(transaction, { client });
  assert.equal(result.status, 'noop');
  assert.deepEqual(client.calls, []);
  assert.equal(result.outcome.successorHint, 'none');
  assert.equal(result.outcome.semanticChange, false);
});

test('a mid-transaction failure is reported honestly with the exact remaining work', () => {
  const issues = settledIssues();
  issues[0].labels = [LABELS.blocked];
  issues[1].dependsOn = [];
  const transaction = planQueueMutationTransaction(curationFor({ queueOverrides: { issues } }), { currentSourceSha: SOURCE_SHA });
  assert.deepEqual(transaction.operations.map((operation) => operation.kind), ['update-labels', 'update-dependencies']);

  const client = recordingClient({ failOn: 'update-dependencies' });
  const result = applyQueueMutationTransaction(transaction, { client });
  assert.equal(result.status, 'partially-applied');
  assert.equal(result.parity.matchesDryRun, false);
  assert.deepEqual(result.appliedOperations.map((operation) => operation.kind), ['update-labels']);
  assert.deepEqual(result.pendingOperations.map((operation) => operation.kind), ['update-dependencies']);
  assert.deepEqual(result.failure, {
    kind: 'update-dependencies',
    curationKey: CURATOR_KEY,
    issueNumber: 11,
    code: 'provider-write-forbidden',
  });
  assert.equal(result.outcome.successorHint, 'delayed-retry');
  assert.equal(result.outcome.successorReason, 'mutation-incomplete');
});

test('a failure on the first operation reports a failed transaction', () => {
  const transaction = planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA });
  const result = applyQueueMutationTransaction(transaction, { client: recordingClient({ failOn: 'create-issue' }) });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.appliedOperations, []);
  assert.equal(result.pendingOperations.length, 2);
});

test('an unbounded client error code is replaced by a bounded one', () => {
  const transaction = planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA });
  const client = {
    createIssue() {
      const error = new Error('boom');
      error.code = { nested: 'not a bounded code' };
      throw error;
    },
  };
  const result = applyQueueMutationTransaction(transaction, { client });
  assert.equal(result.failure.code, 'queue-mutation-failed');
});

test('a creation the port cannot confirm is treated as a failure, not a success', () => {
  const transaction = planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA });
  const client = recordingClient({ createReturns: () => ({ ok: true }) });
  const result = applyQueueMutationTransaction(transaction, { client });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'queue-mutation-unverifiable');
});

test('a transaction cannot be replayed', () => {
  const transaction = planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA });
  applyQueueMutationTransaction(transaction, { client: recordingClient() });
  assert.throws(
    () => applyQueueMutationTransaction(transaction, { client: recordingClient() }),
    /has already been applied; recompute a fresh curation from current evidence/,
  );
});

test('applying a forged transaction is refused', () => {
  const transaction = planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA });
  assert.throws(
    () => applyQueueMutationTransaction({ ...transaction }, { client: recordingClient() }),
    /was not produced by planQueueMutationTransaction/,
  );
});

test('a client missing a required port method is refused before any write', () => {
  const transaction = planQueueMutationTransaction(curationFor(), { currentSourceSha: SOURCE_SHA });
  assert.throws(
    () => applyQueueMutationTransaction(transaction, { client: { updateIssueLabels() {} } }),
    /queue mutation client must implement createIssue\(\) to apply a create-issue operation/,
  );
  assert.throws(() => applyQueueMutationTransaction(transaction, {}), /queue mutation client is required/);
});

test('no operation may target work that is actively owned', () => {
  const issues = settledIssues();
  issues[0].labels = [];
  const curation = curationFor({
    queueOverrides: {
      issues,
      ownership: { activeLeases: [{ issueNumber: 10, kind: 'implementation', holder: 'runner-a' }], openPullRequests: [] },
    },
  });
  const transaction = planQueueMutationTransaction(curation, { currentSourceSha: SOURCE_SHA });
  assert.deepEqual(transaction.operations, []);
  assert.equal(curation.deferred.length, 1);
});

test('an open pull request keeps its issue out of the applied transaction', () => {
  const issues = settledIssues();
  issues[0].labels = [];
  const transaction = planQueueMutationTransaction(curationFor({
    queueOverrides: {
      issues,
      ownership: { activeLeases: [], openPullRequests: [{ number: 44, issueNumber: 10, headSha: HEAD_SHA }] },
    },
  }), { currentSourceSha: SOURCE_SHA });
  assert.deepEqual(transaction.operations.map((operation) => operation.issueNumber), []);
});

test('identical inputs produce an identical transaction fingerprint', () => {
  const first = planQueueMutationTransaction(curationFor({ queueOverrides: { issues: settledIssues() } }), { currentSourceSha: SOURCE_SHA });
  const second = planQueueMutationTransaction(curationFor({ queueOverrides: { issues: settledIssues() } }), { currentSourceSha: SOURCE_SHA });
  assert.equal(first.transactionFingerprint, second.transactionFingerprint);
  assert.equal(serializeQueueMutationTransaction(first), serializeQueueMutationTransaction(second));
});
