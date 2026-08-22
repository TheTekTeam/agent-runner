import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ManagementControlStore } from './agent-runner-management-control-store.mjs';

const T0 = '2026-08-21T20:00:00.000Z';
const T1 = '2026-08-21T20:05:00.000Z';
const REPO = 'FixtureOrg/fixture-repo';
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const OTHER_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
// Assembled at runtime so the adversarial fixture never appears as a literal
// credential in the checked-in source.
const SYNTHETIC_TOKEN = ['ghp', 'a1b2c3d4e5a1b2c3d4e5a1b2c3'].join('_');

function withStore(fn, { now = () => T0, dbPath: supplied = null, dir: suppliedDir = null } = {}) {
  const dir = suppliedDir ?? (supplied ? null : mkdtempSync(join(tmpdir(), 'agent-runner-control-store-')));
  const dbPath = supplied ?? join(dir, 'runner-state.sqlite');
  const store = new ManagementControlStore(dbPath, { now });
  try {
    return fn({ store, dbPath, dir });
  } finally {
    store.close();
    if (dir && !suppliedDir && !supplied) rmSync(dir, { recursive: true, force: true });
  }
}

function decision(overrides = {}) {
  return {
    eventId: 'management-abc',
    projectId: 'fixture-project',
    repository: REPO,
    role: 'programme',
    eventType: 'programme-reconcile-required',
    controlMode: 'active',
    outcome: 'execution-required',
    reason: 'authority-issued',
    mutationSuppressed: false,
    correlationId: 'correlation-1',
    successorCount: 1,
    ...overrides,
  };
}

test('an unconfigured scope reports disabled so a restart can never come back mutating', () => {
  withStore(({ store }) => {
    const mode = store.getControlMode('global');
    assert.equal(mode.mode, 'disabled');
    assert.equal(mode.configured, false);
  });
});

test('a mode change is explicit, attributed and appended to the audit trail', () => {
  withStore(({ store }) => {
    const first = store.setControlMode({ mode: 'shadow', reason: 'begin shadow acceptance', actor: 'operator-1' });
    assert.equal(first.previousMode, null);
    assert.equal(first.mode, 'shadow');
    const second = store.setControlMode({ mode: 'active', reason: 'shadow acceptance positive', actor: 'operator-1' });
    assert.equal(second.previousMode, 'shadow');
    assert.equal(store.getControlMode('global').mode, 'active');
    const audit = store.listControlModeAudit({});
    assert.equal(audit.length, 2);
    assert.deepEqual(audit.map((entry) => entry.mode), ['active', 'shadow']);
  });
});

test('an unknown mode is refused rather than persisted', () => {
  withStore(({ store }) => {
    assert.throws(() => store.setControlMode({ mode: 'enabled', reason: 'x', actor: 'a' }), /unknown management control mode/);
    assert.equal(store.getControlMode('global').configured, false);
  });
});

test('a mode row this build does not recognise reports an unknown mode rather than a permissive one', () => {
  withStore(({ store }) => {
    store.setControlMode({ mode: 'active', reason: 'valid', actor: 'operator-1' });

    // First line of defence: the column constraint refuses an unrecognised mode
    // outright, so this build cannot even write one.
    assert.throws(
      () => store.db.exec("UPDATE management_control_mode_state SET mode = 'supervised' WHERE scope = 'global'"),
      /CHECK constraint failed/,
    );

    // Second line of defence: if a *newer* build ever widens that constraint,
    // this build must still read the unfamiliar value as unknown rather than
    // interpreting it as something permissive. Constraint enforcement is
    // suspended here purely to plant the row a newer build could write.
    store.db.exec('PRAGMA ignore_check_constraints = ON');
    store.db.exec("UPDATE management_control_mode_state SET mode = 'supervised' WHERE scope = 'global'");
    store.db.exec('PRAGMA ignore_check_constraints = OFF');
    const read = store.getControlMode('global');
    assert.equal(read.mode, null);
    assert.equal(read.configured, true);
  });
});

test('a mode reason carrying a local path, secret or log content is refused', () => {
  withStore(({ store }) => {
    for (const reason of [
      'rollback from /home/gp/projects/agent-runner',
      `token ${SYNTHETIC_TOKEN}`,
      '2026-08-21T00:00:00Z ERROR something failed',
      'run $(rm -rf /)',
    ]) {
      assert.throws(() => store.setControlMode({ mode: 'fenced', reason, actor: 'operator-1' }), /Refusing management control write/, reason);
    }
  });
});

test('the manager lock admits one holder and refuses a live contender', () => {
  withStore(({ store }) => {
    const first = store.acquireManagerLock({ holder: 'controller-a', now: T0 });
    assert.equal(first.acquired, true);
    const second = store.acquireManagerLock({ holder: 'controller-b', now: T0 });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'manager-authority-held');
    // The same holder re-entering is not a contender.
    assert.equal(store.acquireManagerLock({ holder: 'controller-a', now: T0 }).acquired, true);
  });
});

test('an expired manager lease is reclaimable so a crashed controller recovers', () => {
  withStore(({ store }) => {
    store.acquireManagerLock({ holder: 'controller-a', leaseMs: 60_000, now: T0 });
    const later = new Date(Date.parse(T0) + 120_000).toISOString();
    assert.equal(store.acquireManagerLock({ holder: 'controller-b', now: later }).acquired, true);
  });
});

test('releasing the lock requires the holder and clears the row', () => {
  withStore(({ store }) => {
    store.acquireManagerLock({ holder: 'controller-a', now: T0 });
    assert.equal(store.releaseManagerLock({ holder: 'controller-b' }).released, false);
    assert.equal(store.releaseManagerLock({ holder: 'controller-a' }).released, true);
    assert.equal(store.getManagerLock('manager-authority'), null);
  });
});

test('the lock never persists a raw holder identity', () => {
  withStore(({ store, dbPath }) => {
    store.acquireManagerLock({ holder: 'controller-secret-holder', now: T0 });
    const row = store.db.prepare('SELECT holder_hash FROM management_control_locks').get();
    assert.notEqual(row.holder_hash, 'controller-secret-holder');
    assert.match(row.holder_hash, /^[0-9a-f]{64}$/);
    assert.ok(dbPath);
  });
});

test('a decision records once and replays idempotently', () => {
  withStore(({ store }) => {
    const first = store.recordDecision(decision());
    assert.equal(first.recorded, true);
    const replay = store.recordDecision(decision());
    assert.equal(replay.recorded, false);
    assert.equal(replay.idempotent, true);
    assert.equal(store.listDecisions({}).length, 1);
  });
});

test('a contradictory decision for the same event fails closed', () => {
  withStore(({ store }) => {
    store.recordDecision(decision());
    assert.throws(
      () => store.recordDecision(decision({ outcome: 'quiescent' })),
      /already recorded with a different outcome/,
    );
  });
});

test('a decision refuses an unknown role, mode or malformed identity', () => {
  withStore(({ store }) => {
    assert.throws(() => store.recordDecision(decision({ role: 'auditor' })), /unknown management role/);
    assert.throws(() => store.recordDecision(decision({ controlMode: 'enabled' })), /unknown management control mode/);
    assert.throws(() => store.recordDecision(decision({ repository: 'not-a-repository' })), /repository is invalid/);
    assert.throws(() => store.recordDecision(decision({ sha: 'nope' })), /exact 40-character commit SHA/);
    assert.throws(() => store.recordDecision(decision({ outcome: 'Not A Token' })), /outcome is invalid/);
  });
});

test('an identical semantic projection dedupes instead of churning', () => {
  withStore(({ store }) => {
    const payload = { projectId: 'fixture-project', lifecycleState: 'quiescent' };
    const first = store.recordProjection({ projectId: 'fixture-project', repository: REPO, fingerprint: FINGERPRINT, payload, now: T0 });
    assert.deepEqual([first.changed, first.revision], [true, 1]);
    const second = store.recordProjection({ projectId: 'fixture-project', repository: REPO, fingerprint: FINGERPRINT, payload, now: T1 });
    assert.equal(second.changed, false);
    assert.equal(second.revision, 1);
    // Neither the revision nor the timestamp moved.
    assert.equal(store.getProjection('fixture-project').updatedAt, T0);
  });
});

test('a changed projection advances the revision', () => {
  withStore(({ store }) => {
    store.recordProjection({ projectId: 'fixture-project', repository: REPO, fingerprint: FINGERPRINT, payload: { a: 1 }, now: T0 });
    const changed = store.recordProjection({ projectId: 'fixture-project', repository: REPO, fingerprint: OTHER_FINGERPRINT, payload: { a: 2 }, now: T1 });
    assert.equal(changed.changed, true);
    assert.equal(changed.revision, 2);
    assert.equal(store.getProjection('fixture-project').updatedAt, T1);
  });
});

test('an assurance finding records once per deterministic identity', () => {
  withStore(({ store }) => {
    const finding = {
      eventId: 'management-abc',
      projectId: 'fixture-project',
      repository: REPO,
      findingClass: 'idle-safe-capacity',
      severity: 'correctable',
      correlationId: 'correlation-1',
    };
    assert.equal(store.recordFinding(finding).recorded, true);
    assert.equal(store.recordFinding(finding).recorded, false);
    assert.equal(store.listFindings({}).length, 1);
    assert.throws(() => store.recordFinding({ ...finding, severity: 'catastrophic' }), /unknown management finding severity/);
  });
});

test('observations are bounded tokens and are trimmed to a bounded retention', () => {
  withStore(({ store }) => {
    assert.throws(() => store.recordObservation({ signal: 'not-a-signal' }), /unknown management observation signal/);
    assert.throws(
      () => store.recordObservation({ signal: 'handler-outcome', detail: 'a free text log line with spaces' }),
      /detail is invalid/,
    );
    for (let index = 0; index < 520; index += 1) {
      store.recordObservation({ signal: 'event-claimed', detail: `claim-${index}` });
    }
    const total = store.db.prepare('SELECT COUNT(*) AS count FROM management_control_observations').get();
    assert.equal(Number(total.count) <= 500, true);
  });
});

test('control-plane state survives reopening the same database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-control-store-restart-'));
  try {
    withStore(({ store }) => {
      store.setControlMode({ mode: 'shadow', reason: 'shadow acceptance', actor: 'operator-1' });
      store.recordDecision(decision());
    }, { dir });
    withStore(({ store }) => {
      assert.equal(store.getControlMode('global').mode, 'shadow');
      assert.equal(store.listDecisions({}).length, 1);
    }, { dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database written by a newer schema is refused rather than downgraded', () => {
  withStore(({ store, dbPath }) => {
    store.db.prepare('INSERT OR REPLACE INTO management_control_schema(version, applied_at) VALUES (?, ?)').run(99, T0);
    store.close();
    assert.throws(() => new ManagementControlStore(dbPath, { now: () => T0 }), /unsupported management control schema version/);
    // Reopen a healthy handle so the fixture teardown has something to close.
    store.db = new ManagementControlStore(join(dbPath, '..', 'reopened.sqlite'), { now: () => T0 }).db;
  });
});
