import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireImplementationSlot,
  markInheritedImplementationSlot,
  processDescendsFromOwner,
  SLOT_INHERITED_ENV,
} from './agent-runner-implementation-slot.mjs';

function makeSlotEnv(prefix = 'slot-ownership-242-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    lockPath: join(dir, 'implementation.lock'),
    env: { AGENT_RUNNER_IMPLEMENTATION_LOCK: join(dir, 'implementation.lock') },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('#242 security: legitimate canonical owner inheritance remains deadlock-free', () => {
  const fixture = makeSlotEnv();
  try {
    const owner = acquireImplementationSlot({ env: fixture.env });
    assert.equal(owner.held, true);
    assert.equal(owner.inherited, false);
    assert.equal(existsSync(fixture.lockPath), true);

    const inheritedEnv = markInheritedImplementationSlot(fixture.env, process.pid);
    const descendant = acquireImplementationSlot({ env: inheritedEnv });
    assert.equal(descendant.held, true);
    assert.equal(descendant.inherited, true);

    descendant.release();
    assert.equal(existsSync(fixture.lockPath), true, 'an inherited release must not release the owner lock');
    owner.release();
  } finally {
    fixture.cleanup();
  }
});

test('#242 security: an arbitrary unrelated live PID cannot grant inheritance', () => {
  const fixture = makeSlotEnv();
  try {
    const owner = acquireImplementationSlot({ env: fixture.env });
    assert.equal(owner.held, true);

    const unrelatedPid = process.pid + 100000;
    const forgedEnv = { ...fixture.env, [SLOT_INHERITED_ENV]: String(unrelatedPid) };
    const forged = acquireImplementationSlot({
      env: forgedEnv,
      isAlive: () => true,
    });

    assert.equal(forged.held, false);
    assert.equal(forged.inherited, false);
    assert.equal(forged.failureReason, 'implementation-slot-inheritance-stale');
    assert.match(forged.detail, /does not own the canonical lock/);
    assert.equal(existsSync(fixture.lockPath), true);
    owner.release();
  } finally {
    fixture.cleanup();
  }
});

test('#242 security: matching lock owner without descendant ancestry cannot grant inheritance', () => {
  const fixture = makeSlotEnv();
  try {
    const env = { ...fixture.env, [SLOT_INHERITED_ENV]: '101' };
    const result = acquireImplementationSlot({
      env,
      isAlive: () => true,
      readLockOwner: () => 101,
      currentPid: 303,
      readParentPid: (pid) => ({ 303: 202, 202: 1 }[pid] ?? null),
    });

    assert.equal(result.held, false);
    assert.equal(result.inherited, false);
    assert.equal(result.failureReason, 'implementation-slot-inheritance-stale');
    assert.match(result.detail, /not a descendant/);
  } finally {
    fixture.cleanup();
  }
});

test('#242 security: verified descendant chain may inherit the exact canonical owner', () => {
  const fixture = makeSlotEnv();
  try {
    const env = { ...fixture.env, [SLOT_INHERITED_ENV]: '101' };
    const result = acquireImplementationSlot({
      env,
      isAlive: () => true,
      readLockOwner: () => 101,
      currentPid: 303,
      readParentPid: (pid) => ({ 303: 202, 202: 101 }[pid] ?? null),
    });

    assert.equal(result.held, true);
    assert.equal(result.inherited, true);
    result.release();
  } finally {
    fixture.cleanup();
  }
});

test('#242 security: stale inherited declaration fails closed and never acquires a fresh lock', () => {
  const fixture = makeSlotEnv();
  try {
    const env = { ...fixture.env, [SLOT_INHERITED_ENV]: '4194304' };
    const result = acquireImplementationSlot({ env, isAlive: () => false });
    assert.equal(result.held, false);
    assert.equal(result.failureReason, 'implementation-slot-inheritance-stale');
    assert.equal(existsSync(fixture.lockPath), false);
  } finally {
    fixture.cleanup();
  }
});

test('#242 security: ancestry resolution fails closed on loops and unreadable parents', () => {
  assert.equal(processDescendsFromOwner({
    ownerPid: 10,
    currentPid: 30,
    readParentPid: (pid) => ({ 30: 20, 20: 30 }[pid]),
  }), false);

  assert.equal(processDescendsFromOwner({
    ownerPid: 10,
    currentPid: 30,
    readParentPid: () => { throw new Error('proc unavailable'); },
  }), false);
});
