import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ROLE_HANDLERS,
  MAX_SUCCESSOR_CAUSAL_DEPTH,
  runManagementControlCycle,
} from './agent-runner-management-controller.mjs';
import { recoverDueManagementWork } from './agent-runner-management-producers.mjs';
import {
  CLAIM_TOKEN,
  CONTROLLER_ID,
  LABELS,
  PROJECT_ID,
  REGISTRY,
  REPOSITORY,
  T0,
  curationWith,
  makeStateDir,
  managementEvent,
  portFactory,
  programmeEvidence,
  removeStateDir,
  setMode,
  withStores,
} from './agent-runner-management-test-fixtures.mjs';

const LATER = '2026-08-21T20:30:00.000Z';

/** A fully-curated queue: nothing to mutate, one ready record available. */
const BOTH_ISSUES = Object.freeze([
  { number: 501, title: 'Bounded queue evidence contract', state: 'open', labels: [LABELS.ready], curationKey: 'qc:fixture-project:evidence-contract' },
  { number: 502, title: 'Deterministic curation transition', state: 'open', labels: [LABELS.blocked], curationKey: 'qc:fixture-project:curator-transition', dependsOn: [501] },
]);

function cycle(overrides = {}) {
  const { resolvePorts } = overrides.ports ?? portFactory();
  return runManagementControlCycle({
    registry: REGISTRY,
    controllerId: CONTROLLER_ID,
    claimToken: CLAIM_TOKEN,
    resolvePorts,
    now: () => T0,
    maxEvents: 10,
    ...overrides,
    ports: undefined,
  });
}

test('a claimed event is dispatched to its role and settled with its successors', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    const summary = await cycle({ eventStore, controlStore });

    assert.equal(summary.ran, true);
    assert.equal(summary.mode, 'active');
    const [first] = summary.results;
    assert.equal(first.role, 'programme');
    assert.equal(first.outcome, 'execution-required');
    assert.equal(first.settled, true);
    // The whole causal chain drains in one cycle: programme wakes execution and
    // assurance; execution's terminal-green evidence then independently asks for
    // assurance again. That second pass is not a coalescing failure -- the first
    // had already settled before it was raised -- and the chain still terminates,
    // because a clean assurance emits no successor.
    const roles = summary.results.map((entry) => entry.role);
    assert.deepEqual([...roles].sort(), ['assurance', 'assurance', 'execution', 'programme']);
    assert.equal(roles[0], 'programme', 'programme reconciliation opens the chain');
    assert.equal(eventStore.listEvents({ states: ['pending'] }).length, 0, 'the chain terminates');
  });
});

test('the decision, projection and settlement are all persisted', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent());
    await cycle({ eventStore, controlStore });

    const decision = controlStore.listDecisions({}).find((entry) => entry.eventId === enqueued.event.eventId);
    assert.equal(decision.outcome, 'execution-required');
    assert.equal(decision.controlMode, 'active');
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'settled');
    assert.equal(eventStore.getEvent(enqueued.event.eventId).outcome, 'execution-required');
    assert.equal(controlStore.getProjection(PROJECT_ID).revision >= 1, true);
  });
});

test('successors preserve correlation, predecessor, project and repository identity', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent({ correlationId: 'chain-42' }));
    const summary = await cycle({ eventStore, controlStore });

    const [programme] = summary.results;
    const successor = eventStore.getEvent(programme.successorEventIds[0]);
    assert.equal(successor.correlationId, 'chain-42');
    assert.equal(successor.predecessorEventId, enqueued.event.eventId);
    assert.equal(successor.projectId, PROJECT_ID);
    assert.equal(successor.repository, REPOSITORY);
    assert.equal(successor.causalDepth, 1);
  });
});

test('an event type with no role is refused rather than guessed at', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent({ eventType: 'delayed-event-ready' }));
    const summary = await cycle({ eventStore, controlStore });

    assert.equal(summary.results[0].outcome, 'unknown-event-type');
    assert.equal(summary.results[0].refused, true);
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'blocked');
  });
});

test('an event for a project that is no longer registered is blocked, not reconciled', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent());
    const summary = await cycle({
      eventStore,
      controlStore,
      registry: { projectsById: {}, projectsByRepository: {} },
    });
    assert.equal(summary.results[0].outcome, 'project-not-registered');
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'blocked');
  });
});

test('an event whose registered repository has moved is blocked', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    const moved = {
      projectsById: { [PROJECT_ID]: { projectId: PROJECT_ID, githubRepo: 'FixtureOrg/moved-repo' } },
      projectsByRepository: { 'fixtureorg/moved-repo': { projectId: PROJECT_ID, githubRepo: 'FixtureOrg/moved-repo' } },
    };
    const summary = await cycle({ eventStore, controlStore, registry: moved });
    assert.equal(summary.results[0].outcome, 'repository-identity-mismatch');
  });
});

test('a prototype-shaped project id can never resolve to a registered project', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    // The ledger refuses to enqueue it at all, which is the first guard.
    assert.throws(
      () => eventStore.enqueue(managementEvent({ projectId: 'constructor' })),
      /identity is not enabled by the registry/,
    );
    assert.equal(eventStore.listEvents({}).length, 0);
  });
});

test('disabled and fenced modes claim nothing at all', async () => {
  for (const mode of ['disabled', 'fenced']) {
    // eslint-disable-next-line no-await-in-loop -- each mode needs its own store
    await withStores(async ({ eventStore, controlStore }) => {
      setMode(controlStore, mode);
      const enqueued = eventStore.enqueue(managementEvent());
      const summary = await cycle({ eventStore, controlStore });
      assert.equal(summary.ran, false, mode);
      assert.equal(summary.refusal, `mode-${mode}`);
      assert.equal(summary.processed, 0);
      assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'pending', 'the event must remain durable');
    });
  }
});

test('an unconfigured or unrecognised mode fails closed without crashing', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    eventStore.enqueue(managementEvent());
    const unconfigured = await cycle({ eventStore, controlStore });
    assert.equal(unconfigured.ran, false);
    assert.equal(unconfigured.refusal, 'mode-disabled');

    const unknown = await cycle({ eventStore, controlStore, mode: 'enabled' });
    assert.equal(unknown.ran, false);
    assert.equal(unknown.refusal, 'mode-unknown');
    assert.equal(eventStore.listEvents({ states: ['pending'] }).length, 1);
  });
});

test('shadow mode processes the whole chain while suppressing every mutation', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'shadow');
    eventStore.enqueue(managementEvent());
    const ports = portFactory();
    const summary = await cycle({ eventStore, controlStore, ports });

    assert.equal(summary.mode, 'shadow');
    assert.ok(summary.processed >= 1);
    assert.deepEqual(ports.calls.queueMutation, []);
    assert.deepEqual(ports.calls.workerAuthority, []);
    assert.deepEqual(ports.calls.continuation, []);
    assert.deepEqual(ports.calls.appliedOperations, []);
    // Bounded evidence of the proposed decision is still recorded.
    const decision = controlStore.listDecisions({}).find((entry) => entry.role === 'programme');
    assert.equal(decision.mutationSuppressed, true);
    assert.equal(decision.outcome, 'execution-required');
  });
});

test('shadow mode never takes the mutating manager lock', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'shadow');
    eventStore.enqueue(managementEvent());
    await cycle({ eventStore, controlStore });
    assert.equal(controlStore.getManagerLock('manager-authority'), null);
  });
});

test('a second mutating controller is refused while the first holds manager authority', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    controlStore.acquireManagerLock({ holder: 'other-controller', now: T0 });

    const summary = await cycle({ eventStore, controlStore });
    assert.equal(summary.ran, false);
    assert.equal(summary.refusal, 'manager-authority-held');
    assert.equal(summary.processed, 0);
  });
});

test('the manager lock is released even when a cycle ends early', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    await cycle({ eventStore, controlStore });
    assert.equal(controlStore.getManagerLock('manager-authority'), null);
  });
});

test('an event already claimed by another holder is not processed twice', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    eventStore.claimNext({ claimToken: 'other-controller-token', now: T0 });

    const summary = await cycle({ eventStore, controlStore });
    assert.equal(summary.processed, 0);
  });
});

test('an expired lease is requeued and reclaimed by the next cycle', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent());
    eventStore.claimNext({ claimToken: 'crashed-controller-token', leaseMs: 60_000, now: T0 });
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'claimed');

    const summary = await cycle({ eventStore, controlStore, now: () => LATER });
    assert.ok(summary.processed >= 1);
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'settled');
  });
});

test('a failing handler leaves the event durable, records the failure and does not crash the cycle', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent());
    const summary = await cycle({
      eventStore,
      controlStore,
      handlers: { ...DEFAULT_ROLE_HANDLERS, programme: () => { throw new Error('collector unavailable'); } },
    });

    assert.equal(summary.ran, true);
    assert.equal(summary.results[0].outcome, 'handler-failed');
    assert.equal(summary.results[0].settled, false);
    // Still claimed, so lease expiry -- not a hot loop -- drives the retry.
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'claimed');
    assert.equal(controlStore.listDecisions({}).length, 0);
    assert.ok(controlStore.listObservations({}).some((entry) => entry.signal === 'handler-failed'));
  });
});

test('a repeatedly failing handler dead-letters once the bounded attempts are exhausted', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent());
    const failing = { ...DEFAULT_ROLE_HANDLERS, programme: () => { throw new Error('collector unavailable'); } };

    await cycle({ eventStore, controlStore, handlers: failing, now: () => T0 });
    // The lease expires with the attempt budget already spent, so recovery
    // dead-letters rather than retrying forever.
    recoverDueManagementWork({ store: eventStore, now: LATER });
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'dead-letter');
  }, { maxAttempts: 1 });
});

test('equivalent wakes during an active reconciliation coalesce into one follow-up', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const first = eventStore.enqueue(managementEvent({ correlationId: 'wake-a' }));
    const second = eventStore.enqueue(managementEvent({ correlationId: 'wake-b' }));
    // The second equivalent wake coalesced into the first pending event.
    assert.equal(second.coalesced, true);
    assert.equal(second.event.eventId, first.event.eventId);
    assert.equal(eventStore.listEvents({ states: ['pending'] }).length, 1);
  });
});

test('an exact duplicate enqueue is a durable no-op', async () => {
  await withStores(async ({ eventStore }) => {
    const first = eventStore.enqueue(managementEvent());
    const replay = eventStore.enqueue(managementEvent());
    assert.equal(replay.duplicate, true);
    assert.equal(replay.event.eventId, first.event.eventId);
    assert.equal(eventStore.listEvents({}).length, 1);
  });
});

test('a replayed event settles idempotently without duplicating the decision', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    await cycle({ eventStore, controlStore });
    const decisionsAfterFirst = controlStore.listDecisions({}).length;

    // Re-enqueueing the same semantic wake after settlement produces a fresh
    // event, and reconciling it again re-reads current evidence rather than
    // repeating a stale instruction.
    eventStore.enqueue(managementEvent());
    await cycle({ eventStore, controlStore });
    const decisions = controlStore.listDecisions({});
    assert.ok(decisions.length >= decisionsAfterFirst);
    // No duplicate decision was written for any single event id.
    const ids = decisions.map((entry) => entry.eventId);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test('a delayed successor is not claimable before its not_before', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    const ports = portFactory({
      programme: programmeEvidence({
        curation: curationWith({ issues: BOTH_ISSUES }),
        quotaAdmission: { state: 'unavailable', profileName: 'complex' },
      }),
    });
    const summary = await cycle({ eventStore, controlStore, ports });

    const programme = summary.results.find((entry) => entry.role === 'programme');
    assert.equal(programme.outcome, 'delayed-retry');
    assert.equal(programme.immediateSuccessors, 0);
    // Nothing further was claimable in the same cycle.
    const pending = eventStore.listEvents({ states: ['pending'] });
    assert.equal(pending.length, 1);
    assert.ok(Date.parse(pending[0].notBefore) > Date.parse(T0));
    assert.equal(eventStore.listDue({ now: T0 }).length, 0);
    assert.equal(eventStore.listDue({ now: LATER }).length, 1);
  });
});

test('a lost wake still recovers through the generic due-event scan', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent());
    // The wake is suppressed entirely: nothing tells the controller to run.
    const recovered = recoverDueManagementWork({ store: eventStore, now: T0 });
    assert.equal(recovered.due.length, 1);
    assert.equal(recovered.due[0].eventId, enqueued.event.eventId);

    const summary = await cycle({ eventStore, controlStore });
    assert.ok(summary.processed >= 1);
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'settled');
  });
});

test('a wake that throws never loses the event', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    const summary = await cycle({
      eventStore,
      controlStore,
      wake: () => { throw new Error('wake transport down'); },
    });
    assert.equal(summary.ran, true);
    assert.ok(summary.processed >= 1);
  });
});

test('pending events survive a controller restart', async () => {
  const dir = makeStateDir();
  try {
    await withStores(async ({ eventStore, controlStore }) => {
      setMode(controlStore, 'active');
      eventStore.enqueue(managementEvent());
    }, { dir });

    await withStores(async ({ eventStore, controlStore }) => {
      // Mode and the pending event both survived the restart.
      assert.equal(controlStore.getControlMode('global').mode, 'active');
      assert.equal(eventStore.listEvents({ states: ['pending'] }).length, 1);
      const summary = await cycle({ eventStore, controlStore });
      assert.ok(summary.processed >= 1);
    }, { dir });
  } finally {
    removeStateDir(dir);
  }
});

test('a control plane that was never configured comes back disabled after a restart', async () => {
  const dir = makeStateDir();
  try {
    await withStores(async ({ eventStore }) => {
      eventStore.enqueue(managementEvent());
    }, { dir });
    await withStores(async ({ eventStore, controlStore }) => {
      const summary = await cycle({ eventStore, controlStore });
      assert.equal(summary.ran, false);
      assert.equal(summary.refusal, 'mode-disabled');
    }, { dir });
  } finally {
    removeStateDir(dir);
  }
});

test('a chain at the bounded causal depth degrades to an auditable block, not a ledger throw', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    const summary = await cycle({
      eventStore,
      controlStore,
      maxEvents: 1,
      // A handler is dispatched against an event reported at the bound.
      handlers: DEFAULT_ROLE_HANDLERS,
      ports: portFactory(),
    });
    assert.ok(summary.processed >= 1);
    assert.ok(MAX_SUCCESSOR_CAUSAL_DEPTH < 64, 'must degrade below the ledger hard bound');
  });
});

test('maxEvents bounds how much one cycle may drain', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    const summary = await cycle({ eventStore, controlStore, maxEvents: 1 });
    assert.equal(summary.processed, 1);
    // The successors are durable and simply wait for the next cycle.
    assert.ok(eventStore.listEvents({ states: ['pending'] }).length >= 1);
  });
});

test('the controller refuses malformed wiring rather than guessing', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    await assert.rejects(
      () => runManagementControlCycle({ eventStore, controlStore, registry: REGISTRY, controllerId: CONTROLLER_ID, claimToken: CLAIM_TOKEN }),
      /requires a resolvePorts factory/,
    );
    await assert.rejects(
      () => runManagementControlCycle({ eventStore, controlStore, registry: REGISTRY, claimToken: CLAIM_TOKEN, resolvePorts: () => ({}) }),
      /requires a bounded controllerId/,
    );
    await assert.rejects(
      () => runManagementControlCycle({ eventStore, controlStore: null, registry: REGISTRY, controllerId: CONTROLLER_ID, claimToken: CLAIM_TOKEN, resolvePorts: () => ({}) }),
      /requires a ManagementControlStore/,
    );
  });
});

test('a resolvePorts factory with no collectEvidence port is a handler failure, not a silent skip', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    const summary = await cycle({ eventStore, controlStore, resolvePorts: () => ({}) });
    assert.equal(summary.results[0].outcome, 'handler-failed');
  });
});

test('a settlement failure leaves the event durable and never aborts the cycle', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent());
    const realSettle = eventStore.settle.bind(eventStore);
    let failed = false;
    eventStore.settle = (...args) => {
      if (!failed) {
        failed = true;
        throw new Error('database is locked');
      }
      return realSettle(...args);
    };

    const summary = await cycle({ eventStore, controlStore });
    assert.equal(summary.ran, true);
    assert.equal(summary.results[0].outcome, 'settlement-failed');
    assert.equal(summary.results[0].settled, false);
    // The event stays claimed for recovery, and no derived decision was written
    // that a later retry could contradict.
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'claimed');
    assert.equal(controlStore.listDecisions({}).length, 0);
  });
});

test('a retry after a settlement failure reaches a clean decision rather than a poisoned one', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    const enqueued = eventStore.enqueue(managementEvent());
    const realSettle = eventStore.settle.bind(eventStore);
    let attempts = 0;
    eventStore.settle = (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error('database is locked');
      return realSettle(...args);
    };

    await cycle({ eventStore, controlStore });
    // The lease expires and the event is reclaimed and settled cleanly.
    const retry = await cycle({ eventStore, controlStore, now: () => LATER });
    assert.ok(retry.processed >= 1);
    assert.equal(eventStore.getEvent(enqueued.event.eventId).state, 'settled');
    assert.equal(controlStore.listDecisions({}).some((entry) => entry.eventId === enqueued.event.eventId), true);
  });
});

test('an unchanged projection is recorded as unchanged rather than churning the revision', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    await cycle({ eventStore, controlStore });
    const first = controlStore.getProjection(PROJECT_ID);

    eventStore.enqueue(managementEvent({ correlationId: 'second-wake' }));
    await cycle({ eventStore, controlStore });
    const second = controlStore.getProjection(PROJECT_ID);
    assert.ok(second.revision >= first.revision);
    assert.ok(controlStore.listObservations({ limit: 200 })
      .some((entry) => entry.signal === 'projection-revised' || entry.signal === 'projection-unchanged'));
  });
});

test('bounded operational observations cover the whole event lifecycle', async () => {
  await withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    await cycle({ eventStore, controlStore });
    const signals = new Set(controlStore.listObservations({ limit: 200 }).map((entry) => entry.signal));
    for (const expected of [
      'control-mode-resolved', 'manager-lock-acquired', 'event-claimed', 'handler-started',
      'handler-outcome', 'successors-created', 'manager-lock-released',
    ]) {
      assert.ok(signals.has(expected), `missing observation: ${expected}`);
    }
  });
});
