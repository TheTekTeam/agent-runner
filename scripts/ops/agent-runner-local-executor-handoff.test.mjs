import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  LocalExecutorHandoffStore,
  runLocalExecutorHandoffCycle,
} from './agent-runner-local-executor-handoff.mjs';

const T0 = '2026-08-01T02:00:00.000Z';
const T1 = '2026-08-01T02:30:00.000Z';

const registry = Object.freeze({
  projectsById: Object.freeze({
    alpha: Object.freeze({
      projectId: 'alpha',
      githubRepo: 'Example/Alpha',
    }),
  }),
});

const policy = Object.freeze({
  projectsById: Object.freeze({
    alpha: Object.freeze({ projectId: 'alpha' }),
  }),
});

function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-handoff-test-'));
  const path = join(directory, 'controller.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE event_triage_releases (
      batch_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      released_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claim_token TEXT,
      claim_expires_at TEXT,
      payload_json TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.close();
  return {
    path,
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function insertRelease(path, {
  batchId,
  state = 'processed',
  projectId = 'alpha',
  repository = 'Example/Alpha',
  resultKind = 'queue-triage-execution',
  resultState = 'processed',
  updatedAt = T0,
} = {}) {
  const db = new DatabaseSync(path);
  try {
    const payload = {
      schemaVersion: 1,
      batchId,
      projectId,
      repository,
      objectKind: 'issue',
      objectNumber: 104,
      rawPayload: 'must-not-enter-the-executor-job',
    };
    const result = {
      schemaVersion: 1,
      kind: resultKind,
      state: resultState,
      release: {
        batchId,
        projectId,
        repository,
      },
    };
    db.prepare(`
      INSERT INTO event_triage_releases(
        batch_id, state, released_at, updated_at, payload_json, result_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      state,
      '2026-08-01T01:55:00.000Z',
      updatedAt,
      JSON.stringify(payload),
      JSON.stringify(result),
    );
  } finally {
    db.close();
  }
}

function withStore(path, callback) {
  const store = new LocalExecutorHandoffStore(path);
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

function activate(path, now = T0) {
  return withStore(
    path,
    (store) => store.discoverProcessedReleases(registry, { now }),
  );
}

test('activation skips history and then discovers one deterministic read-only handoff', () => {
  const fixture = databaseFixture();
  try {
    insertRelease(fixture.path, {
      batchId: 'batch-history-001',
      updatedAt: '2026-08-01T01:00:00.000Z',
    });

    assert.equal(activate(fixture.path, T0).length, 0);

    insertRelease(fixture.path, {
      batchId: 'batch-alpha-0001',
      updatedAt: T1,
    });

    const first = withStore(
      fixture.path,
      (store) => store.discoverProcessedReleases(registry, {
        now: '2026-08-01T02:31:00.000Z',
      }),
    );
    const second = withStore(
      fixture.path,
      (store) => store.discoverProcessedReleases(registry, {
        now: '2026-08-01T02:32:00.000Z',
      }),
    );

    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(first[0].batchId, 'batch-alpha-0001');
    assert.equal(first[0].state, 'pending');
    assert.equal(first[0].job.projectId, 'alpha');
    assert.equal(first[0].job.operation, 'project.inspect');
    assert.equal(first[0].job.expectedSha, null);
    assert.deepEqual(first[0].job.arguments, {});
    assert.match(first[0].job.jobId, /^triage-inspect-[0-9a-f]{48}$/);
    assert.match(first[0].job.nonce, /^triage-inspect-nonce-[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(first[0].job).includes('must-not-enter'), false);
    assert.equal(withStore(
      fixture.path,
      (store) => store.getHandoff('batch-history-001'),
    ), null);
  } finally {
    fixture.close();
  }
});

test('does not consume pending releases or non-triage processed results', () => {
  const fixture = databaseFixture();
  try {
    activate(fixture.path);
    insertRelease(fixture.path, {
      batchId: 'batch-pending-001',
      state: 'pending',
    });
    insertRelease(fixture.path, {
      batchId: 'batch-other-00001',
      resultKind: 'some-other-consumer',
    });

    const discovered = withStore(
      fixture.path,
      (store) => store.discoverProcessedReleases(registry, { now: T0 }),
    );

    assert.equal(discovered.length, 0);
    assert.equal(withStore(
      fixture.path,
      (store) => store.listHandoffs({ states: ['pending', 'running', 'succeeded', 'failed'] }).length,
    ), 0);
  } finally {
    fixture.close();
  }
});

test('a processed release with conflicting project identity fails closed', () => {
  const fixture = databaseFixture();
  try {
    activate(fixture.path);
    insertRelease(fixture.path, {
      batchId: 'batch-mismatch-001',
      repository: 'Example/Other',
    });

    assert.throws(
      () => withStore(
        fixture.path,
        (store) => store.discoverProcessedReleases(registry, { now: T0 }),
      ),
      /repository identity mismatch/,
    );
    assert.equal(withStore(
      fixture.path,
      (store) => store.listHandoffs({ states: ['pending', 'running', 'succeeded', 'failed'] }).length,
    ), 0);
  } finally {
    fixture.close();
  }
});

test('expired handoff with no local job is requeued but an active lease is preserved', () => {
  const fixture = databaseFixture();
  try {
    activate(fixture.path);
    insertRelease(fixture.path, {
      batchId: 'batch-lease-00001',
      updatedAt: T1,
    });
    withStore(fixture.path, (store) => {
      store.discoverProcessedReleases(registry, { now: T0 });
      const claimed = store.claimHandoff('batch-lease-00001', {
        claimToken: 'handoff-claim-token-0001',
        leaseMs: 60_000,
        now: T0,
      });
      assert.equal(claimed.state, 'running');

      const localStore = {
        getJob() {
          return null;
        },
      };
      assert.equal(store.reconcileExpiredClaims(localStore, {
        now: '2026-08-01T02:00:30.000Z',
      }).length, 0);
      assert.equal(store.getHandoff('batch-lease-00001').state, 'running');

      assert.equal(store.reconcileExpiredClaims(localStore, {
        now: '2026-08-01T02:01:01.000Z',
      }).length, 1);
      assert.equal(store.getHandoff('batch-lease-00001').state, 'pending');
    });
  } finally {
    fixture.close();
  }
});

test('an expired handoff adopts a durable final local job without re-execution', () => {
  const fixture = databaseFixture();
  try {
    activate(fixture.path);
    insertRelease(fixture.path, {
      batchId: 'batch-final-00001',
      updatedAt: T1,
    });
    withStore(fixture.path, (store) => {
      const [handoff] = store.discoverProcessedReleases(registry, { now: T0 });
      store.claimHandoff(handoff.batchId, {
        claimToken: 'handoff-final-token-0001',
        leaseMs: 1_000,
        now: T0,
      });
      const localStore = {
        getJob(jobId) {
          return {
            jobId,
            state: 'succeeded',
            finishedAt: '2026-08-01T02:00:01.000Z',
            errorCode: null,
            result: {
              path: '/must/not/be/copied/to/handoff',
              headSha: 'a'.repeat(40),
            },
          };
        },
      };

      const reconciled = store.reconcileExpiredClaims(localStore, {
        now: '2026-08-01T02:00:02.000Z',
      });

      assert.equal(reconciled.length, 1);
      const final = store.getHandoff(handoff.batchId);
      assert.equal(final.state, 'succeeded');
      assert.equal(final.result.recoveredAfterRestart, true);
      assert.equal('path' in final.result.job, false);
      assert.match(final.result.job.resultFingerprint, /^sha256:[0-9a-f]{64}$/);
    });
  } finally {
    fixture.close();
  }
});

test('cycle recovers first, executes only project.inspect and persists a compact success', () => {
  const fixture = databaseFixture();
  try {
    activate(fixture.path);
    insertRelease(fixture.path, {
      batchId: 'batch-cycle-00001',
      updatedAt: T1,
    });
    const order = [];
    const localStore = {
      getJob() {
        return null;
      },
      db: {
        prepare() {
          return { get() { return null; } };
        },
      },
      close() {
        order.push('close-local');
      },
    };

    const result = runLocalExecutorHandoffCycle({
      controllerDb: fixture.path,
      registry,
      policy,
      now: '2026-08-01T02:31:00.000Z',
      uid: 1000,
      localStoreFactory() {
        return localStore;
      },
      recover() {
        order.push('recover');
        return [];
      },
      execute({ input }) {
        order.push(`execute:${input.operation}`);
        assert.equal(input.operation, 'project.inspect');
        assert.deepEqual(input.arguments, {});
        return {
          replay: false,
          job: {
            jobId: input.jobId,
            state: 'succeeded',
            finishedAt: T0,
            errorCode: null,
            result: {
              path: '/private/canonical/path',
              repository: 'Example/Alpha',
              clean: true,
            },
          },
        };
      },
    });

    assert.deepEqual(order.slice(0, 2), ['recover', 'execute:project.inspect']);
    assert.equal(result.discoveredHandoffs, 1);
    assert.equal(result.executedHandoffs, 1);
    assert.equal(result.outcomes[0].state, 'succeeded');

    const final = withStore(
      fixture.path,
      (store) => store.getHandoff('batch-cycle-00001'),
    );
    assert.equal(final.state, 'succeeded');
    assert.equal(final.result.replay, false);
    assert.equal('path' in final.result.job, false);
    assert.equal(JSON.stringify(final.result).includes('/private/'), false);
  } finally {
    fixture.close();
  }
});

test('a refusal before a final local job fails only the handoff with a bounded code', () => {
  const fixture = databaseFixture();
  try {
    activate(fixture.path);
    insertRelease(fixture.path, {
      batchId: 'batch-refused-0001',
      updatedAt: T1,
    });
    const localStore = {
      getJob() {
        return null;
      },
      db: {
        prepare() {
          return { get() { return null; } };
        },
      },
      close() {},
    };

    const result = runLocalExecutorHandoffCycle({
      controllerDb: fixture.path,
      registry,
      policy,
      now: '2026-08-01T02:31:00.000Z',
      uid: 1000,
      localStoreFactory() {
        return localStore;
      },
      recover() {
        return [];
      },
      execute() {
        const error = new Error('raw provider text must not persist');
        error.code = 'project-locked';
        throw error;
      },
    });

    assert.equal(result.outcomes[0].state, 'failed');
    const final = withStore(
      fixture.path,
      (store) => store.getHandoff('batch-refused-0001'),
    );
    assert.equal(final.state, 'failed');
    assert.equal(final.errorCode, 'project-locked');
    assert.deepEqual(final.result, {
      refusedBeforeFinalJob: true,
      errorCode: 'project-locked',
    });
    assert.equal(JSON.stringify(final).includes('raw provider text'), false);
  } finally {
    fixture.close();
  }
});
