import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGEMENT_EVENT_PRODUCERS,
  produceManagementEvents,
  recoverDueManagementWork,
} from './agent-runner-management-producers.mjs';
import { MANAGEMENT_EVENT_TYPES, ManagementEventStore } from './agent-runner-management-events.mjs';
import { ManagementControlStore } from './agent-runner-management-control-store.mjs';
import {
  PROJECT_ID,
  REPOSITORY,
  T0,
  makeStateDir,
  removeStateDir,
  withStores,
} from './agent-runner-management-test-fixtures.mjs';

const LATER = '2026-08-21T20:30:00.000Z';
const FP_A = `sha256:${'1'.repeat(64)}`;
const FP_B = `sha256:${'2'.repeat(64)}`;

function transition(overrides = {}) {
  return {
    kind: 'github-evidence-settled',
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    evidenceFingerprint: FP_A,
    ...overrides,
  };
}

function produce(stores, transitions, options = {}) {
  return produceManagementEvents({
    eventStore: stores.eventStore,
    controlStore: stores.controlStore,
    transitions,
    now: T0,
    ...options,
  });
}

test('every producer maps to an allowlisted management event type', () => {
  for (const [kind, eventType] of Object.entries(MANAGEMENT_EVENT_PRODUCERS)) {
    assert.ok(MANAGEMENT_EVENT_TYPES.includes(eventType), `${kind} -> ${eventType}`);
  }
});

test('all fourteen required material transitions have a producer', () => {
  for (const kind of [
    'github-evidence-settled', 'worker-ownership-changed', 'worker-terminal-result',
    'implementation-published', 'pull-request-published', 'pull-request-head-changed',
    'required-checks-terminal', 'review-actionable', 'merge-evidence-accepted',
    'source-activation-settled', 'dependency-readiness-changed',
    'implementation-slot-occupied', 'implementation-slot-freed', 'assurance-discrepancy',
  ]) {
    assert.ok(MANAGEMENT_EVENT_PRODUCERS[kind], `missing producer for ${kind}`);
  }
});

test('transitions that change what runs next wake programme reconciliation', async () => {
  await withStores(async (stores) => {
    for (const kind of ['merge-evidence-accepted', 'source-activation-settled', 'dependency-readiness-changed', 'implementation-slot-freed', 'assurance-discrepancy']) {
      assert.equal(MANAGEMENT_EVENT_PRODUCERS[kind], 'programme-reconcile-required', kind);
    }
    const result = produce(stores, [transition({ kind: 'implementation-slot-freed' })]);
    assert.equal(result.produced[0].eventType, 'programme-reconcile-required');
    assert.equal(result.produced[0].inserted, true);
  });
});

test('transitions about an in-flight attempt wake execution reconciliation', async () => {
  await withStores(async (stores) => {
    const result = produce(stores, [transition({
      kind: 'pull-request-head-changed', issueNumber: 501, pullRequestNumber: 42, sha: 'd'.repeat(40),
    })]);
    assert.equal(result.produced[0].eventType, 'execution-reconcile-required');
    const event = stores.eventStore.getEvent(result.produced[0].eventId);
    assert.equal(event.issueNumber, 501);
    assert.equal(event.pullRequestNumber, 42);
    assert.equal(event.sha, 'd'.repeat(40));
  });
});

// ------------------------------------------------------- durable semantic dedupe

test('first semantic evidence produces exactly one event', async () => {
  await withStores(async (stores) => {
    const result = produce(stores, [transition()]);
    assert.equal(result.insertedCount, 1);
    assert.equal(result.suppressedCount, 0);
    assert.equal(stores.eventStore.listEvents({}).length, 1);
    // The accepted fingerprint is durable, not caller memory.
    const state = stores.controlStore.getProducerState(result.produced[0].scopeKey);
    assert.equal(state.evidenceFingerprint, FP_A);
    assert.equal(state.eventId, result.produced[0].eventId);
  });
});

test('the same evidence observed again while the event is still pending produces no duplicate', async () => {
  await withStores(async (stores) => {
    produce(stores, [transition()]);
    const replay = produce(stores, [transition()]);
    assert.equal(replay.suppressedCount, 1);
    assert.equal(replay.produced.length, 0);
    assert.equal(stores.eventStore.listEvents({}).length, 1);
  });
});

test('the same evidence observed again AFTER the first event settles still produces no new event', async () => {
  await withStores(async (stores) => {
    const first = produce(stores, [transition()]);
    // Drain the event completely, so #289 coalescing no longer protects anything.
    stores.eventStore.claimNext({ claimToken: 'producer-dedupe-token', now: T0 });
    stores.eventStore.settle(first.produced[0].eventId, {
      claimToken: 'producer-dedupe-token', state: 'settled', outcome: 'quiescent', now: T0,
    });
    assert.equal(stores.eventStore.getEvent(first.produced[0].eventId).state, 'settled');

    const replay = produce(stores, [transition()], { now: LATER });
    assert.equal(replay.suppressedCount, 1);
    assert.equal(replay.produced.length, 0);
    assert.equal(stores.eventStore.listEvents({}).length, 1);
  });
});

test('a different caller correlation cannot defeat semantic suppression', async () => {
  await withStores(async (stores) => {
    const first = produce(stores, [transition({ correlationId: 'caller-correlation-one' })]);
    stores.eventStore.claimNext({ claimToken: 'producer-dedupe-token', now: T0 });
    stores.eventStore.settle(first.produced[0].eventId, {
      claimToken: 'producer-dedupe-token', state: 'settled', outcome: 'quiescent', now: T0,
    });

    const replay = produce(stores, [transition({ correlationId: 'caller-correlation-two' })], { now: LATER });
    assert.equal(replay.suppressedCount, 1);
    assert.equal(stores.eventStore.listEvents({}).length, 1);
  });
});

test('genuinely changed evidence produces exactly one new event, and replaying it suppresses again', async () => {
  await withStores(async (stores) => {
    produce(stores, [transition({ evidenceFingerprint: FP_A })]);
    const changed = produce(stores, [transition({ evidenceFingerprint: FP_B })], { now: LATER });
    assert.equal(changed.suppressedCount, 0);
    assert.equal(changed.produced.length, 1);
    // The scope is the same object, so the new wake coalesced into the pending one.
    assert.equal(changed.produced[0].coalesced || changed.produced[0].inserted, true);

    const replayChanged = produce(stores, [transition({ evidenceFingerprint: FP_B })], { now: LATER });
    assert.equal(replayChanged.suppressedCount, 1);
    // And the stored fingerprint advanced to the newer evidence.
    assert.equal(stores.controlStore.getProducerState(changed.produced[0].scopeKey).evidenceFingerprint, FP_B);
  });
});

test('dedupe scope is per object, so a different issue is not suppressed by another', async () => {
  await withStores(async (stores) => {
    const one = produce(stores, [transition({ kind: 'pull-request-head-changed', issueNumber: 501, evidenceFingerprint: FP_A })]);
    const two = produce(stores, [transition({ kind: 'pull-request-head-changed', issueNumber: 502, evidenceFingerprint: FP_A })]);
    assert.equal(one.suppressedCount, 0);
    assert.equal(two.suppressedCount, 0);
    assert.notEqual(one.produced[0].scopeKey, two.produced[0].scopeKey);
  });
});

test('a failed enqueue does not advance the stored producer fingerprint', async () => {
  await withStores(async (stores) => {
    const scopeKey = ManagementControlStore.producerScopeKey({
      producerKind: 'github-evidence-settled', projectId: PROJECT_ID, repository: REPOSITORY,
    });
    const realEnqueue = stores.eventStore.enqueueInTransaction.bind(stores.eventStore);
    stores.eventStore.enqueueInTransaction = () => { throw new Error('database is locked'); };
    assert.throws(() => produce(stores, [transition()]), /database is locked/);
    // Neither the event nor the fingerprint exists: the transaction unwound.
    assert.equal(stores.controlStore.getProducerState(scopeKey), null);
    assert.equal(stores.eventStore.listEvents({}).length, 0);

    // The same evidence is therefore still able to produce its event.
    stores.eventStore.enqueueInTransaction = realEnqueue;
    const retry = produce(stores, [transition()]);
    assert.equal(retry.insertedCount, 1);
    assert.equal(stores.controlStore.getProducerState(scopeKey).evidenceFingerprint, FP_A);
  });
});

test('suppression survives a restart of the controller database', async () => {
  const dir = makeStateDir();
  try {
    await withStores(async (stores) => {
      const first = produce(stores, [transition()]);
      stores.eventStore.claimNext({ claimToken: 'producer-dedupe-token', now: T0 });
      stores.eventStore.settle(first.produced[0].eventId, {
        claimToken: 'producer-dedupe-token', state: 'settled', outcome: 'quiescent', now: T0,
      });
    }, { dir });

    await withStores(async (stores) => {
      // Reopened database: the dedupe history is persisted, not in memory.
      const replay = produce(stores, [transition()], { now: LATER });
      assert.equal(replay.suppressedCount, 1);
      assert.equal(stores.eventStore.listEvents({}).length, 1);
    }, { dir });
  } finally {
    removeStateDir(dir);
  }
});

test('a cosmetic re-observation never churns events however often it is polled', async () => {
  await withStores(async (stores) => {
    for (let poll = 0; poll < 5; poll += 1) {
      produce(stores, [transition()], { now: poll === 0 ? T0 : LATER });
    }
    assert.equal(stores.eventStore.listEvents({}).length, 1);
    const scopeKey = ManagementControlStore.producerScopeKey({
      producerKind: 'github-evidence-settled', projectId: PROJECT_ID, repository: REPOSITORY,
    });
    // Only the first observation was ever accepted.
    assert.equal(stores.controlStore.getProducerState(scopeKey).observedCount, 1);
  });
});

test('durable dedupe requires the shared connection and fails closed without it', async () => {
  await withStores(async (stores) => {
    const separate = new ManagementControlStore(stores.dbPath, { now: () => T0 });
    try {
      assert.throws(
        () => produceManagementEvents({
          eventStore: stores.eventStore, controlStore: separate, transitions: [transition()], now: T0,
        }),
        /must share one connection for durable producer dedupe/,
      );
    } finally {
      separate.close();
    }
  });
});

// ------------------------------------------------------- refusals and bounds

test('a producer cannot be invented: an unrecognised transition kind is refused', async () => {
  await withStores(async (stores) => {
    assert.throws(() => produce(stores, [transition({ kind: 'label-updated' })]), /unrecognised transition kind: label-updated/);
    assert.throws(() => produce(stores, [transition({ mutationInstruction: 'add label' })]), /unsupported field\(s\): mutationInstruction/);
  });
});

test('a transition that cannot prove change is refused rather than allowed to wake the manager', async () => {
  await withStores(async (stores) => {
    const { evidenceFingerprint, ...withoutFingerprint } = transition();
    assert.throws(() => produce(stores, [withoutFingerprint]), /evidenceFingerprint must be a bounded semantic evidence fingerprint/);
    assert.throws(() => produce(stores, [transition({ evidenceFingerprint: 'short' })]), /evidenceFingerprint/);
  });
});

test('an unregistered project or mismatched repository fails closed at the ledger', async () => {
  await withStores(async (stores) => {
    assert.throws(() => produce(stores, [transition({ projectId: 'unknown-project' })]), /identity is not enabled by the registry/);
    assert.throws(() => produce(stores, [transition({ repository: 'Other/repo' })]), /identity is not enabled by the registry/);
  });
});

test('two different transitions that mean the same reconciliation coalesce into one event', async () => {
  await withStores(async (stores) => {
    const result = produce(stores, [
      transition({ kind: 'merge-evidence-accepted', evidenceFingerprint: FP_A }),
      transition({ kind: 'dependency-readiness-changed', evidenceFingerprint: FP_B }),
    ]);
    assert.equal(result.insertedCount, 1);
    assert.equal(result.coalescedCount, 1);
    assert.equal(stores.eventStore.listEvents({ states: ['pending'] }).length, 1);
    // Both producer scopes still recorded their accepted fingerprint.
    assert.equal(result.produced.length, 2);
  });
});

test('a correlation id is derived deterministically when the caller supplies none', async () => {
  await withStores(async (stores) => {
    const result = produce(stores, [transition({ evidenceFingerprint: `sha256:${'9'.repeat(64)}` })]);
    const event = stores.eventStore.getEvent(result.produced[0].eventId);
    assert.equal(event.correlationId, `github-evidence-settled-${'9'.repeat(32)}`);
  });
});

test('a delayed transition is durable but not yet due', async () => {
  await withStores(async (stores) => {
    const result = produce(stores, [transition({ notBefore: LATER })]);
    assert.equal(result.produced[0].inserted, true);
    assert.equal(result.dueCount, 0);
    assert.equal(stores.eventStore.listDue({ now: T0 }).length, 0);
    assert.equal(stores.eventStore.listDue({ now: LATER }).length, 1);
  });
});

test('durability completes before the best-effort wake, and a failing wake loses nothing', async () => {
  await withStores(async (stores) => {
    const observed = [];
    const result = produce(stores, [transition()], {
      wake: () => {
        observed.push(stores.eventStore.listEvents({ states: ['pending'] }).length);
        throw new Error('wake transport down');
      },
    });
    assert.deepEqual(observed, [1]);
    assert.equal(result.wake.attempted, true);
    assert.equal(result.wake.ok, false);
    assert.equal(stores.eventStore.listEvents({ states: ['pending'] }).length, 1);
  });
});

test('production is bounded', async () => {
  await withStores(async (stores) => {
    const many = Array.from({ length: 101 }, (unused, index) => transition({ evidenceFingerprint: `sha256:${String(index).padStart(64, '0')}` }));
    assert.throws(() => produce(stores, many), /exceed the bounded limit/);
  });
});

// ------------------------------------------------------- generic recovery

test('the generic recovery seam recovers due work without deciding anything', async () => {
  await withStores(async (stores) => {
    produce(stores, [transition({ notBefore: LATER })]);
    assert.equal(recoverDueManagementWork({ store: stores.eventStore, now: T0 }).due.length, 0);
    const recovered = recoverDueManagementWork({ store: stores.eventStore, now: LATER });
    assert.equal(recovered.due.length, 1);
    assert.deepEqual(Object.keys(recovered).sort(), ['due', 'recovery', 'wake']);
  });
});

test('the recovery seam expires a stale lease so a crashed controller does not stall the graph', async () => {
  await withStores(async (stores) => {
    produce(stores, [transition()]);
    stores.eventStore.claimNext({ claimToken: 'crashed-controller-token', leaseMs: 60_000, now: T0 });
    const recovered = recoverDueManagementWork({ store: stores.eventStore, now: LATER });
    assert.equal(recovered.recovery.requeued, 1);
    assert.equal(recovered.due.length, 1);
  });
});

test('the recovery seam is transport only and never constructs a management decision', async () => {
  await withStores(async (stores) => {
    assert.ok(stores.eventStore instanceof ManagementEventStore);
    const recovered = recoverDueManagementWork({ store: stores.eventStore, now: T0 });
    assert.equal(recovered.due.length, 0);
    assert.equal(stores.controlStore.listDecisions({}).length, 0);
  });
});
