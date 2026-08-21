import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { EventIngressStore } from './agent-runner-event-ingress.mjs';
import {
  MANAGEMENT_EVENT_SCHEMA_VERSION,
  MANAGEMENT_EVENT_TYPES,
  ManagementEventStore,
  enqueueManagementEventAndWake,
  normalizeManagementEvent,
  recoverDueManagementEvents,
} from './agent-runner-management-events.mjs';

const T0 = '2026-08-21T19:45:00.000Z';
const T1 = '2026-08-21T19:46:00.000Z';
const T2 = '2026-08-21T19:47:00.000Z';
const T3 = '2026-08-21T19:48:00.000Z';

const ALPHA = Object.freeze({ projectId: 'alpha', githubRepo: 'Owner/Alpha' });
const BETA = Object.freeze({ projectId: 'beta', githubRepo: 'Owner/Beta' });
const REGISTRY = Object.freeze({
  projectsById: Object.freeze({ alpha: ALPHA, beta: BETA }),
  projectsByRepository: Object.freeze({
    'owner/alpha': ALPHA,
    'owner/beta': BETA,
  }),
});

function event(overrides = {}) {
  return {
    eventType: 'programme-reconcile-required',
    projectId: 'alpha',
    repository: 'Owner/Alpha',
    correlationId: 'github-batch-42',
    issueNumber: 42,
    sha: 'a'.repeat(40),
    ...overrides,
  };
}

function withStore(fn, { maxAttempts = 5, dbPath: suppliedPath = null } = {}) {
  const dir = suppliedPath ? null : mkdtempSync(join(tmpdir(), 'agent-runner-management-events-'));
  const dbPath = suppliedPath ?? join(dir, 'runner-state.sqlite');
  const store = new ManagementEventStore(dbPath, {
    registry: REGISTRY,
    maxAttempts,
    now: () => T0,
  });
  try {
    return fn({ store, dbPath });
  } finally {
    store.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

test('uses a bounded project-neutral event vocabulary and validates registry identity', () => {
  assert.deepEqual([...MANAGEMENT_EVENT_TYPES], [
    'programme-reconcile-required',
    'execution-reconcile-required',
    'queue-assurance-required',
    'delayed-event-ready',
  ]);

  const normalized = normalizeManagementEvent(event(), { registry: REGISTRY, now: T0 });
  assert.equal(normalized.schemaVersion, MANAGEMENT_EVENT_SCHEMA_VERSION);
  assert.equal(normalized.repository, 'Owner/Alpha');
  assert.equal(normalized.projectId, 'alpha');
  assert.match(normalized.eventId, /^management-[0-9a-f]{32}$/);
  assert.match(normalized.fingerprint, /^sha256:[0-9a-f]{64}$/);

  assert.throws(
    () => normalizeManagementEvent(event({ eventType: 'merge-now' }), { registry: REGISTRY, now: T0 }),
    /not allowlisted/,
  );
  assert.throws(
    () => normalizeManagementEvent(event({ repository: 'Owner/Beta' }), { registry: REGISTRY, now: T0 }),
    /identity/,
  );
  assert.throws(
    () => normalizeManagementEvent(event({ projectId: 'unknown' }), { registry: REGISTRY, now: T0 }),
    /identity/,
  );
});

test('coexists with the accepted ingress schema in the same controller SQLite store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-management-events-shared-db-'));
  const dbPath = join(dir, 'controller.sqlite');
  try {
    const ingress = new EventIngressStore(dbPath, { now: () => T0 });
    ingress.close();
    const management = new ManagementEventStore(dbPath, { registry: REGISTRY, now: () => T0 });
    management.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name IN ('webhook_deliveries', 'management_events')
        ORDER BY name
      `).all().map((row) => row.name);
      assert.deepEqual(tables, ['management_events', 'webhook_deliveries']);
      const version = db.prepare('SELECT MAX(version) AS version FROM management_event_schema').get();
      assert.equal(Number(version.version), MANAGEMENT_EVENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deduplicates exact replay after settlement and coalesces only active reconciliation scope', () => withStore(({ store }) => {
  const first = store.enqueue(event(), { now: T0 });
  assert.equal(first.inserted, true);

  const claimed = store.claimNext({ claimToken: 'claim-token-0001', now: T0, leaseMs: 60_000 });
  assert.equal(claimed.eventId, first.event.eventId);
  store.settle(claimed.eventId, { claimToken: 'claim-token-0001', now: T1 });

  const replay = store.enqueue(event(), { now: T2 });
  assert.equal(replay.inserted, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.event.eventId, first.event.eventId);
  assert.equal(replay.event.state, 'settled');

  const newCause = store.enqueue(event({ correlationId: 'github-batch-43' }), { now: T2 });
  assert.equal(newCause.inserted, true);
  assert.notEqual(newCause.event.eventId, first.event.eventId);

  const coalesced = store.enqueue(event({ correlationId: 'github-batch-44', sha: 'b'.repeat(40) }), { now: T3 });
  assert.equal(coalesced.inserted, false);
  assert.equal(coalesced.duplicate, false);
  assert.equal(coalesced.coalesced, true);
  assert.equal(coalesced.event.eventId, newCause.event.eventId);
  assert.equal(store.listEvents().length, 2);
}));

test('settles an event and enqueues its successor atomically with causal linkage', () => withStore(({ store }) => {
  const source = store.enqueue(event({ eventType: 'execution-reconcile-required' }), { now: T0 }).event;
  store.claimNext({ claimToken: 'claim-token-0002', now: T0, leaseMs: 60_000 });

  const settled = store.settle(source.eventId, {
    claimToken: 'claim-token-0002',
    outcome: 'execution-settled',
    now: T1,
    successors: [{
      eventType: 'programme-reconcile-required',
      issueNumber: 42,
      sha: 'b'.repeat(40),
    }],
  });
  assert.equal(settled.idempotent, false);
  assert.equal(settled.event.state, 'settled');
  assert.equal(settled.event.outcome, 'execution-settled');
  assert.equal(settled.successors.length, 1);
  assert.equal(settled.successors[0].inserted, true);
  assert.equal(settled.successors[0].event.predecessorEventId, source.eventId);
  assert.equal(settled.successors[0].event.correlationId, source.correlationId);

  const repeated = store.settle(source.eventId, {
    claimToken: 'claim-token-0002',
    outcome: 'execution-settled',
    now: T2,
    successors: [{ eventType: 'programme-reconcile-required', issueNumber: 42 }],
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.successors.length, 0);
  assert.equal(store.listEvents().length, 2);
}));

test('fails closed on an out-of-order successor whose predecessor does not exist', () => withStore(({ store }) => {
  assert.throws(
    () => store.enqueue(event({ predecessorEventId: 'management-00000000000000000000000000000000' }), { now: T0 }),
    /predecessor does not exist/,
  );
  assert.equal(store.listEvents().length, 0);
}));

test('keeps delayed events durable and unclaimable until not_before', () => withStore(({ store }) => {
  const delayed = store.enqueue(event({
    eventType: 'delayed-event-ready',
    correlationId: 'quota-reset-42',
    notBefore: T2,
  }), { now: T0 }).event;
  assert.equal(delayed.notBefore, T2);
  assert.equal(store.listDue({ now: T1 }).length, 0);
  assert.equal(store.claimNext({ claimToken: 'claim-token-0003', now: T1, leaseMs: 60_000 }), null);

  const claimed = store.claimNext({ claimToken: 'claim-token-0003', now: T2, leaseMs: 60_000 });
  assert.equal(claimed.eventId, delayed.eventId);
  assert.equal(claimed.state, 'claimed');
}));

test('recovers expired leases and dead-letters repeated claim failures without hot looping', () => withStore(({ store }) => {
  const queued = store.enqueue(event(), { now: T0 }).event;
  const first = store.claimNext({ claimToken: 'claim-token-0004', now: T0, leaseMs: 1_000 });
  assert.equal(first.attemptCount, 1);

  const recoveryOne = store.recoverExpiredClaims({ now: '2026-08-21T19:45:02.000Z' });
  assert.equal(recoveryOne.requeued, 1);
  assert.equal(store.getEvent(queued.eventId).state, 'pending');

  const second = store.claimNext({
    claimToken: 'claim-token-0005',
    now: '2026-08-21T19:45:02.000Z',
    leaseMs: 1_000,
  });
  assert.equal(second.attemptCount, 2);

  const recoveryTwo = store.recoverExpiredClaims({ now: '2026-08-21T19:45:04.000Z' });
  assert.equal(recoveryTwo.deadLettered, 1);
  const terminal = store.getEvent(queued.eventId);
  assert.equal(terminal.state, 'dead-letter');
  assert.equal(terminal.outcome, 'lease-attempts-exhausted');
  assert.equal(store.claimNext({ claimToken: 'claim-token-0006', now: T3, leaseMs: 1_000 }), null);
}, { maxAttempts: 2 }));

test('blocks an event whose bounded deadline expires before it is processed', () => withStore(({ store }) => {
  const queued = store.enqueue(event({ deadlineAt: T1 }), { now: T0 }).event;
  const recovery = store.recoverDueEvents({ now: T2 });
  assert.equal(recovery.recovery.deadlineBlocked, 1);
  assert.equal(recovery.due.length, 0);
  const blocked = store.getEvent(queued.eventId);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.outcome, 'deadline-expired');
}));

test('bounds and deterministically orders generic due-event recovery scans', () => withStore(({ store }) => {
  for (let issueNumber = 1; issueNumber <= 4; issueNumber += 1) {
    store.enqueue(event({
      eventType: 'delayed-event-ready',
      issueNumber,
      correlationId: `delay-${issueNumber}`,
      notBefore: T0,
      sha: null,
    }), { now: T0 });
  }
  const due = store.recoverDueEvents({ now: T1, limit: 2 }).due;
  assert.equal(due.length, 2);
  assert.deepEqual(due.map((item) => item.issueNumber), [1, 2]);
  assert.throws(() => store.listDue({ now: T1, limit: 201 }), /limit/);
}));

test('persists before wake and recovers a due event after a lost wake', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-management-wake-'));
  const dbPath = join(dir, 'runner-state.sqlite');
  try {
    const firstStore = new ManagementEventStore(dbPath, { registry: REGISTRY, now: () => T0 });
    const initial = enqueueManagementEventAndWake({
      store: firstStore,
      event: event(),
      now: T0,
      wake: () => {
        const error = new Error('simulated lost wake');
        error.code = 'wake-channel-down';
        throw error;
      },
    });
    assert.equal(initial.inserted, true);
    assert.deepEqual(initial.wake, { attempted: true, ok: false, errorCode: 'wake-channel-down' });
    const eventId = initial.event.eventId;
    firstStore.close();

    const secondStore = new ManagementEventStore(dbPath, { registry: REGISTRY, now: () => T1 });
    try {
      const calls = [];
      const recovered = recoverDueManagementEvents({
        store: secondStore,
        now: T1,
        wake: (payload) => calls.push(payload),
      });
      assert.equal(recovered.due.length, 1);
      assert.equal(recovered.due[0].eventId, eventId);
      assert.equal(recovered.wake.ok, true);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        schemaVersion: 1,
        reason: 'management-event-recovery',
        dueCount: 1,
      });
    } finally {
      secondStore.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects prompt/output/path-shaped payload fields instead of persisting unrestricted data', () => withStore(({ store, dbPath }) => {
  assert.throws(() => store.enqueue({ ...event(), prompt: 'do dangerous hidden work' }, { now: T0 }), /unsupported field/);
  assert.throws(() => store.enqueue({ ...event(), providerOutput: 'secret model output' }, { now: T0 }), /unsupported field/);
  assert.throws(() => store.enqueue(event({ correlationId: '/home/gp/private/path' }), { now: T0 }), /correlationId is invalid/);
  assert.equal(store.listEvents().length, 0);

  store.enqueue(event({ correlationId: 'safe-correlation-1' }), { now: T0 });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT event_type, project_id, repo, correlation_id, exact_sha
      FROM management_events
    `).get();
    assert.deepEqual(row, {
      event_type: 'programme-reconcile-required',
      project_id: 'alpha',
      repo: 'Owner/Alpha',
      correlation_id: 'safe-correlation-1',
      exact_sha: 'a'.repeat(40),
    });
  } finally {
    db.close();
  }
}));

test('different projects do not coalesce into one active management event', () => withStore(({ store }) => {
  const alpha = store.enqueue(event(), { now: T0 });
  const beta = store.enqueue(event({
    projectId: 'beta',
    repository: 'Owner/Beta',
    correlationId: 'github-batch-42',
  }), { now: T0 });
  assert.equal(alpha.inserted, true);
  assert.equal(beta.inserted, true);
  assert.notEqual(alpha.event.eventId, beta.event.eventId);
  assert.equal(store.listEvents().length, 2);
}));
