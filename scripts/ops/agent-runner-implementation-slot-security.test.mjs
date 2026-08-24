import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireImplementationSlot,
  IMPLEMENTATION_LANE_ENV,
  markInheritedImplementationSlot,
  processDescendsFromOwner,
  SLOT_INHERITED_ENV,
} from './agent-runner-implementation-slot.mjs';

function makeSlotEnv(prefix = 'slot-ownership-242-', lane = null) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const lockPath = lane ? join(dir, `${lane.replace(/[^A-Za-z0-9._-]+/g, '-')}.lock`) : join(dir, 'implementation.lock');
  const env = lane
    ? { AGENT_RUNNER_IMPLEMENTATION_LANE_ROOT: dir, [IMPLEMENTATION_LANE_ENV]: lane }
    : { AGENT_RUNNER_IMPLEMENTATION_LOCK: lockPath };
  return {
    dir,
    lockPath,
    env,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('#242 security: legitimate exact-lane owner inheritance remains deadlock-free', () => {
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

test('#51 security: different scheduler-assigned lanes have independent lock ownership', () => {
  const one = makeSlotEnv('slot-lane-51-', 'modelspend:issue:792');
  try {
    const first = acquireImplementationSlot({ env: one.env });
    assert.equal(first.held, true);
    assert.equal(first.lane, 'modelspend:issue:792');
    const secondEnv = { ...one.env, [IMPLEMENTATION_LANE_ENV]: 'agent-runner:issue:314' };
    const second = acquireImplementationSlot({ env: secondEnv });
    assert.equal(second.held, true);
    assert.notEqual(second.lockPath, first.lockPath);
    second.release();
    first.release();
  } finally {
    one.cleanup();
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
    assert.match(forged.detail, /does not own the exact lane lock/);
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
