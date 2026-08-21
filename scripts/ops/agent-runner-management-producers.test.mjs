import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGEMENT_EVENT_PRODUCERS,
  produceManagementEvents,
  recoverDueManagementWork,
} from './agent-runner-management-producers.mjs';
import { MANAGEMENT_EVENT_TYPES } from './agent-runner-management-events.mjs';
import {
  PROJECT_ID,
  REPOSITORY,
  T0,
  withStores,
} from './agent-runner-management-test-fixtures.mjs';

const LATER = '2026-08-21T20:30:00.000Z';

function transition(overrides = {}) {
  return {
    kind: 'github-evidence-settled',
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    evidenceFingerprint: `sha256:${'1'.repeat(64)}`,
    ...overrides,
  };
}

test('every producer maps to an allowlisted management event type', () => {
  for (const [kind, eventType] of Object.entries(MANAGEMENT_EVENT_PRODUCERS)) {
    assert.ok(MANAGEMENT_EVENT_TYPES.includes(eventType), `${kind} -> ${eventType}`);
  }
});

test('all fourteen required material transitions have a producer', () => {
  for (const kind of [
    'github-evidence-settled',
    'worker-ownership-changed',
    'worker-terminal-result',
    'implementation-published',
    'pull-request-published',
    'pull-request-head-changed',
    'required-checks-terminal',
    'review-actionable',
    'merge-evidence-accepted',
    'source-activation-settled',
    'dependency-readiness-changed',
    'implementation-slot-occupied',
    'implementation-slot-freed',
    'assurance-discrepancy',
  ]) {
    assert.ok(MANAGEMENT_EVENT_PRODUCERS[kind], `missing producer for ${kind}`);
  }
});

test('transitions that change what runs next wake programme reconciliation', async () => {
  await withStores(async ({ eventStore }) => {
    for (const kind of ['merge-evidence-accepted', 'source-activation-settled', 'dependency-readiness-changed', 'implementation-slot-freed', 'assurance-discrepancy']) {
      assert.equal(MANAGEMENT_EVENT_PRODUCERS[kind], 'programme-reconcile-required', kind);
    }
    const result = produceManagementEvents({
      store: eventStore,
      transitions: [transition({ kind: 'implementation-slot-freed', evidenceFingerprint: `sha256:${'2'.repeat(64)}` })],
      now: T0,
    });
    assert.equal(result.produced[0].eventType, 'programme-reconcile-required');
    assert.equal(result.produced[0].inserted, true);
  });
});

test('transitions about an in-flight attempt wake execution reconciliation', async () => {
  await withStores(async ({ eventStore }) => {
    const result = produceManagementEvents({
      store: eventStore,
      transitions: [transition({
        kind: 'pull-request-head-changed',
        issueNumber: 501,
        pullRequestNumber: 42,
        sha: 'd'.repeat(40),
        evidenceFingerprint: `sha256:${'3'.repeat(64)}`,
      })],
      now: T0,
    });
    assert.equal(result.produced[0].eventType, 'execution-reconcile-required');
    const event = eventStore.getEvent(result.produced[0].eventId);
    assert.equal(event.issueNumber, 501);
    assert.equal(event.pullRequestNumber, 42);
    assert.equal(event.sha, 'd'.repeat(40));
  });
});

test('unchanged semantic evidence produces no event at all', async () => {
  await withStores(async ({ eventStore }) => {
    const fingerprint = `sha256:${'4'.repeat(64)}`;
    const result = produceManagementEvents({
      store: eventStore,
      transitions: [transition({ evidenceFingerprint: fingerprint, previousEvidenceFingerprint: fingerprint })],
      now: T0,
    });
    assert.equal(result.produced.length, 0);
    assert.equal(result.suppressedCount, 1);
    assert.equal(result.suppressed[0].reason, 'unchanged-evidence');
    assert.equal(eventStore.listEvents({}).length, 0);
  });
});

test('a cosmetic change that leaves the semantic fingerprint alone cannot wake the manager', async () => {
  await withStores(async ({ eventStore }) => {
    const fingerprint = `sha256:${'5'.repeat(64)}`;
    // Three consecutive polls observing the same semantic evidence.
    for (let poll = 0; poll < 3; poll += 1) {
      produceManagementEvents({
        store: eventStore,
        transitions: [transition({ evidenceFingerprint: fingerprint, previousEvidenceFingerprint: fingerprint })],
        now: T0,
      });
    }
    assert.equal(eventStore.listEvents({}).length, 0);
  });
});

test('a producer cannot be invented: an unrecognised transition kind is refused', async () => {
  await withStores(async ({ eventStore }) => {
    assert.throws(
      () => produceManagementEvents({ store: eventStore, transitions: [transition({ kind: 'label-updated' })], now: T0 }),
      /unrecognised transition kind: label-updated/,
    );
    assert.throws(
      () => produceManagementEvents({ store: eventStore, transitions: [transition({ mutationInstruction: 'add label' })], now: T0 }),
      /unsupported field\(s\): mutationInstruction/,
    );
  });
});

test('a transition that cannot prove change is refused rather than allowed to wake the manager', async () => {
  await withStores(async ({ eventStore }) => {
    const { evidenceFingerprint, ...withoutFingerprint } = transition();
    assert.throws(
      () => produceManagementEvents({ store: eventStore, transitions: [withoutFingerprint], now: T0 }),
      /evidenceFingerprint must be a bounded semantic evidence fingerprint/,
    );
    assert.throws(
      () => produceManagementEvents({ store: eventStore, transitions: [transition({ evidenceFingerprint: 'short' })], now: T0 }),
      /evidenceFingerprint/,
    );
  });
});

test('an unregistered project or mismatched repository fails closed at the ledger', async () => {
  await withStores(async ({ eventStore }) => {
    assert.throws(
      () => produceManagementEvents({ store: eventStore, transitions: [transition({ projectId: 'unknown-project' })], now: T0 }),
      /identity is not enabled by the registry/,
    );
    assert.throws(
      () => produceManagementEvents({ store: eventStore, transitions: [transition({ repository: 'Other/repo' })], now: T0 }),
      /identity is not enabled by the registry/,
    );
  });
});

test('replaying the same transition set is deterministic and idempotent', async () => {
  await withStores(async ({ eventStore }) => {
    const transitions = [transition({ evidenceFingerprint: `sha256:${'6'.repeat(64)}` })];
    const first = produceManagementEvents({ store: eventStore, transitions, now: T0 });
    const replay = produceManagementEvents({ store: eventStore, transitions, now: T0 });
    assert.equal(first.produced[0].inserted, true);
    assert.equal(replay.produced[0].inserted, false);
    assert.equal(replay.produced[0].duplicate, true);
    assert.equal(replay.produced[0].eventId, first.produced[0].eventId);
    assert.equal(eventStore.listEvents({}).length, 1);
  });
});

test('two different transitions that mean the same reconciliation coalesce into one', async () => {
  await withStores(async ({ eventStore }) => {
    const result = produceManagementEvents({
      store: eventStore,
      transitions: [
        transition({ kind: 'merge-evidence-accepted', evidenceFingerprint: `sha256:${'7'.repeat(64)}` }),
        transition({ kind: 'dependency-readiness-changed', evidenceFingerprint: `sha256:${'8'.repeat(64)}` }),
      ],
      now: T0,
    });
    assert.equal(result.insertedCount, 1);
    assert.equal(result.coalescedCount, 1);
    assert.equal(eventStore.listEvents({ states: ['pending'] }).length, 1);
  });
});

test('a correlation id is derived deterministically when the caller supplies none', async () => {
  await withStores(async ({ eventStore }) => {
    const result = produceManagementEvents({
      store: eventStore,
      transitions: [transition({ evidenceFingerprint: `sha256:${'9'.repeat(64)}` })],
      now: T0,
    });
    const event = eventStore.getEvent(result.produced[0].eventId);
    assert.equal(event.correlationId, `github-evidence-settled-${'9'.repeat(32)}`);
  });
});

test('a delayed transition is durable but not yet due', async () => {
  await withStores(async ({ eventStore }) => {
    const result = produceManagementEvents({
      store: eventStore,
      transitions: [transition({ evidenceFingerprint: `sha256:${'a'.repeat(64)}`, notBefore: LATER })],
      now: T0,
    });
    assert.equal(result.produced[0].inserted, true);
    assert.equal(eventStore.listDue({ now: T0 }).length, 0);
    assert.equal(eventStore.listDue({ now: LATER }).length, 1);
  });
});

test('durability completes before the best-effort wake, and a failing wake loses nothing', async () => {
  await withStores(async ({ eventStore }) => {
    const observed = [];
    produceManagementEvents({
      store: eventStore,
      transitions: [transition({ evidenceFingerprint: `sha256:${'b'.repeat(64)}` })],
      wake: () => {
        // The event must already be durable by the time the wake is attempted.
        observed.push(eventStore.listEvents({ states: ['pending'] }).length);
        throw new Error('wake transport down');
      },
      now: T0,
    });
    assert.deepEqual(observed, [1]);
    assert.equal(eventStore.listEvents({ states: ['pending'] }).length, 1);
  });
});

test('production is bounded', async () => {
  await withStores(async ({ eventStore }) => {
    const many = Array.from({ length: 101 }, (unused, index) => transition({ evidenceFingerprint: `sha256:${String(index).padStart(64, '0')}` }));
    assert.throws(() => produceManagementEvents({ store: eventStore, transitions: many, now: T0 }), /exceed the bounded limit/);
  });
});

test('the generic recovery seam recovers due work without deciding anything', async () => {
  await withStores(async ({ eventStore }) => {
    produceManagementEvents({
      store: eventStore,
      transitions: [transition({ evidenceFingerprint: `sha256:${'c'.repeat(64)}`, notBefore: LATER })],
      now: T0,
    });
    assert.equal(recoverDueManagementWork({ store: eventStore, now: T0 }).due.length, 0);
    const recovered = recoverDueManagementWork({ store: eventStore, now: LATER });
    assert.equal(recovered.due.length, 1);
    // Recovery reports what is due; it selects no work and issues no authority.
    assert.deepEqual(Object.keys(recovered).sort(), ['due', 'recovery', 'wake']);
  });
});

test('the recovery seam expires a stale lease so a crashed controller does not stall the graph', async () => {
  await withStores(async ({ eventStore }) => {
    produceManagementEvents({
      store: eventStore,
      transitions: [transition({ evidenceFingerprint: `sha256:${'d'.repeat(64)}` })],
      now: T0,
    });
    eventStore.claimNext({ claimToken: 'crashed-controller-token', leaseMs: 60_000, now: T0 });
    const recovered = recoverDueManagementWork({ store: eventStore, now: LATER });
    assert.equal(recovered.recovery.requeued, 1);
    assert.equal(recovered.due.length, 1);
  });
});
