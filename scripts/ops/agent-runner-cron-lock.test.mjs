import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireRecoverableCronLock,
  parseCronLock,
  processIsAlive,
} from './agent-runner-cron-lock.mjs';

function withTempLock(run) {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-lock-'));
  const lockPath = join(root, '.var/claude-runner/cron.lock');
  try { run(lockPath); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('parses only well-formed pid and timestamp metadata', () => {
  assert.deepEqual(parseCronLock('123\n2026-07-21T05:55:11.000Z\n'), {
    pid: 123,
    createdAt: '2026-07-21T05:55:11.000Z',
  });
  assert.equal(parseCronLock('not-a-pid\n2026-07-21T05:55:11.000Z\n'), null);
  assert.equal(parseCronLock('123\nnot-a-date\n'), null);
});

test('process probe treats ESRCH as stale and ambiguity as active', () => {
  assert.equal(processIsAlive(10, () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; }), false);
  assert.equal(processIsAlive(10, () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; }), true);
  assert.equal(processIsAlive(10, () => undefined), true);
});

test('acquires and releases a fresh lock', () => withTempLock((lockPath) => {
  const unlock = acquireRecoverableCronLock(lockPath, {
    pid: 321,
    now: () => '2026-07-21T13:00:00.000Z',
  });
  assert.equal(readFileSync(lockPath, 'utf8'), '321\n2026-07-21T13:00:00.000Z\n');
  unlock();
  assert.throws(() => readFileSync(lockPath, 'utf8'), { code: 'ENOENT' });
}));

test('refuses to remove a lock held by a live owner', () => withTempLock((lockPath) => {
  writeFileSync(lockPath, '456\n2026-07-21T12:00:00.000Z\n', { flag: 'wx' });
  assert.throws(() => acquireRecoverableCronLock(lockPath, {
    processIsAlive: () => true,
  }), /held by active or unverifiable process 456/);
  assert.equal(readFileSync(lockPath, 'utf8'), '456\n2026-07-21T12:00:00.000Z\n');
}));

test('recovers a well-formed stale lock and owns the replacement', () => withTempLock((lockPath) => {
  writeFileSync(lockPath, '456\n2026-07-21T05:55:11.000Z\n', { flag: 'wx' });
  const unlock = acquireRecoverableCronLock(lockPath, {
    pid: 789,
    now: () => '2026-07-21T13:00:00.000Z',
    processIsAlive: () => false,
  });
  assert.equal(readFileSync(lockPath, 'utf8'), '789\n2026-07-21T13:00:00.000Z\n');
  unlock();
  assert.throws(() => readFileSync(lockPath, 'utf8'), { code: 'ENOENT' });
}));

test('fails closed without removing malformed ownership metadata', () => withTempLock((lockPath) => {
  writeFileSync(lockPath, 'corrupt lock data\n', { flag: 'wx' });
  assert.throws(() => acquireRecoverableCronLock(lockPath, {
    processIsAlive: () => false,
  }), /malformed or ambiguous ownership metadata/);
  assert.equal(readFileSync(lockPath, 'utf8'), 'corrupt lock data\n');
}));

test('cleanup never removes a lock replaced by another owner', () => withTempLock((lockPath) => {
  const unlock = acquireRecoverableCronLock(lockPath, {
    pid: 321,
    now: () => '2026-07-21T13:00:00.000Z',
  });
  writeFileSync(lockPath, '999\n2026-07-21T13:01:00.000Z\n');
  unlock();
  assert.equal(readFileSync(lockPath, 'utf8'), '999\n2026-07-21T13:01:00.000Z\n');
}));
