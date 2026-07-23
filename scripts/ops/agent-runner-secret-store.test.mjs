import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireSecretLease,
  createSecret,
  ensureSecretStoreDir,
  getSecretStatus,
  listSecretStatuses,
  markSecretRotationRequired,
  readSecretValueForEnvironment,
  releaseSecretLease,
  removeSecret,
  replaceSecret,
  resolveSecretStoreDir,
  rotateSecret,
  SecretActiveError,
  SecretLockedError,
  SECRET_STATUS,
  validateSecretId,
  verifySecretStoreIntegrity,
} from './agent-runner-secret-store.mjs';

// Synthetic test values only — never a real credential shape.
const SYNTHETIC_VALUE_A = 'synthetic-test-value-alpha-000';
const SYNTHETIC_VALUE_B = 'synthetic-test-value-beta-111';

function withTempStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-secret-store-'));
  try {
    return fn(join(dir, 'secrets'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- id / reference validation (path traversal, absolute, malformed) ---

test('validateSecretId accepts a plain alphanumeric/dash/underscore id', () => {
  assert.equal(validateSecretId('codex-session-token').ok, true);
  assert.equal(validateSecretId('A1_b2-C3').ok, true);
});

test('validateSecretId rejects path traversal', () => {
  assert.equal(validateSecretId('../etc/passwd').ok, false);
  assert.equal(validateSecretId('..').ok, false);
  assert.equal(validateSecretId('a/../../b').ok, false);
});

test('validateSecretId rejects path separators and absolute paths', () => {
  assert.equal(validateSecretId('a/b').ok, false);
  assert.equal(validateSecretId('/etc/passwd').ok, false);
  assert.equal(validateSecretId('a\\b').ok, false);
});

test('validateSecretId rejects malformed and oversized ids', () => {
  assert.equal(validateSecretId('').ok, false);
  assert.equal(validateSecretId(null).ok, false);
  assert.equal(validateSecretId('has space').ok, false);
  assert.equal(validateSecretId('has\nnewline').ok, false);
  assert.equal(validateSecretId('.hidden').ok, false);
  assert.equal(validateSecretId('a'.repeat(65)).ok, false);
});

test('resolveSecretStoreDir defaults under XDG state, outside any source checkout', () => {
  assert.equal(resolveSecretStoreDir({ HOME: '/home/example' }), '/home/example/.local/state/agent-runner/secrets');
});

test('resolveSecretStoreDir honours an explicit machine-local override', () => {
  assert.equal(
    resolveSecretStoreDir({ HOME: '/home/example', AGENT_RUNNER_SECRET_STORE_DIR: '/mnt/secrets' }),
    '/mnt/secrets',
  );
});

// --- directory and file ownership/modes ---

test('ensureSecretStoreDir creates a mode-0700 directory', () => withTempStore((dir) => {
  ensureSecretStoreDir(dir);
  const stats = lstatSync(dir);
  assert.equal(stats.mode & 0o777, 0o700);
  assert.equal(stats.isDirectory(), true);
}));

test('createSecret writes a mode-0600 file', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  const path = join(dir, 'agent-token.secret.json');
  const stats = lstatSync(path);
  assert.equal(stats.mode & 0o777, 0o600);
  assert.equal(stats.isFile(), true);
}));

test('ensureSecretStoreDir self-heals directory mode drift back to 0700 on every call, then verifies it', () => withTempStore((dir) => {
  ensureSecretStoreDir(dir);
  chmodSync(dir, 0o755);
  ensureSecretStoreDir(dir);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
}));

test('getSecretStatus reports invalid on permission drift of the secret file itself', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  chmodSync(join(dir, 'agent-token.secret.json'), 0o644);
  const status = getSecretStatus(dir, 'agent-token');
  assert.equal(status.status, SECRET_STATUS.INVALID);
  assert.equal(status.reason, 'wrong-mode');
}));

// --- atomic create / replace / rotate / remove ---

test('createSecret then getSecretStatus reports configured', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  const status = getSecretStatus(dir, 'agent-token');
  assert.equal(status.status, SECRET_STATUS.CONFIGURED);
}));

test('getSecretStatus on a missing id reports missing, never throws', () => withTempStore((dir) => {
  const status = getSecretStatus(dir, 'never-created');
  assert.equal(status.status, SECRET_STATUS.MISSING);
}));

test('createSecret refuses to overwrite an existing valid secret', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  assert.throws(() => createSecret(dir, 'agent-token', SYNTHETIC_VALUE_B), (error) => error.code === 'AGENT_RUNNER_SECRET_ALREADY_EXISTS');
  assert.equal(readSecretValueForEnvironment(dir, 'agent-token').value, SYNTHETIC_VALUE_A);
}));

test('replaceSecret refuses to create a new entry that does not already exist', () => withTempStore((dir) => {
  assert.throws(() => replaceSecret(dir, 'agent-token', SYNTHETIC_VALUE_A), /AGENT_RUNNER_SECRET_NOT_FOUND|does not exist/);
  assert.equal(getSecretStatus(dir, 'agent-token').status, SECRET_STATUS.MISSING);
}));

test('replaceSecret swaps the value atomically', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  replaceSecret(dir, 'agent-token', SYNTHETIC_VALUE_B);
  assert.equal(readSecretValueForEnvironment(dir, 'agent-token').value, SYNTHETIC_VALUE_B);
}));

test('rotateSecret updates the value and stamps rotatedAt, clearing rotation-required', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  markSecretRotationRequired(dir, 'agent-token');
  assert.equal(getSecretStatus(dir, 'agent-token').status, SECRET_STATUS.ROTATION_REQUIRED);
  rotateSecret(dir, 'agent-token', SYNTHETIC_VALUE_B);
  const status = getSecretStatus(dir, 'agent-token');
  assert.equal(status.status, SECRET_STATUS.CONFIGURED);
  assert.ok(status.rotatedAt);
  assert.equal(readSecretValueForEnvironment(dir, 'agent-token').value, SYNTHETIC_VALUE_B);
}));

test('removeSecret deletes the entry and is a no-op success when already absent', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  removeSecret(dir, 'agent-token');
  assert.equal(getSecretStatus(dir, 'agent-token').status, SECRET_STATUS.MISSING);
  const second = removeSecret(dir, 'agent-token');
  assert.equal(second.status, SECRET_STATUS.MISSING);
}));

// --- rollback after partial failure ---

test('rollback: a failing rename during rotate leaves the prior valid value intact', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  assert.throws(() => rotateSecret(dir, 'agent-token', SYNTHETIC_VALUE_B, {
    renameFn: () => { throw new Error('simulated disk failure during rename'); },
  }));
  const status = getSecretStatus(dir, 'agent-token');
  assert.equal(status.status, SECRET_STATUS.CONFIGURED);
  assert.equal(readSecretValueForEnvironment(dir, 'agent-token').value, SYNTHETIC_VALUE_A);
}));

test('rollback: a failing write mid-create leaves no partial secret behind', () => withTempStore((dir) => {
  assert.throws(() => createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A, {
    writeFn: () => { throw new Error('simulated disk-full mid-write'); },
  }));
  assert.equal(getSecretStatus(dir, 'agent-token').status, SECRET_STATUS.MISSING);
}));

test('a partially-written / corrupt secret file reports invalid, not configured or a crash', () => withTempStore((dir) => {
  ensureSecretStoreDir(dir);
  writeFileSync(join(dir, 'agent-token.secret.json'), '{"schemaVersion":"agent-runner-secret/v1","value":"trunc', { mode: 0o600 });
  const status = getSecretStatus(dir, 'agent-token');
  assert.equal(status.status, SECRET_STATUS.INVALID);
}));

test('a tampered digest (value edited without going through the store) reports invalid', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  const path = join(dir, 'agent-token.secret.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.value = 'tampered-value';
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  assert.equal(getSecretStatus(dir, 'agent-token').status, SECRET_STATUS.INVALID);
}));

test('recovery from a corrupt entry: remove then create succeeds', () => withTempStore((dir) => {
  ensureSecretStoreDir(dir);
  writeFileSync(join(dir, 'agent-token.secret.json'), 'not json at all', { mode: 0o600 });
  removeSecret(dir, 'agent-token');
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  assert.equal(getSecretStatus(dir, 'agent-token').status, SECRET_STATUS.CONFIGURED);
}));

// --- symlink replacement defenses ---

test('a symlink at the store directory path is detected and rejected, never followed', () => withTempStore((dir, root) => {
  const decoyDir = join(root, 'decoy-dir');
  mkdirSync(decoyDir, { recursive: true, mode: 0o700 });
  symlinkSync(decoyDir, dir);
  assert.throws(() => createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A), /AGENT_RUNNER_SECRET_STORE_DIR_UNSAFE|symlink/);
}));

test('a symlink swapped in at a secret path is refused on read and on write, never followed', () => withTempStore((dir, root) => {
  ensureSecretStoreDir(dir);
  const decoyTarget = join(root, 'decoy-secret.txt');
  writeFileSync(decoyTarget, 'not-a-real-secret-file-content');
  const path = join(dir, 'agent-token.secret.json');
  symlinkSync(decoyTarget, path);

  const status = getSecretStatus(dir, 'agent-token');
  assert.equal(status.status, SECRET_STATUS.INVALID);
  assert.equal(status.reason, 'symlink');

  assert.throws(() => createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A));
  assert.throws(() => replaceSecret(dir, 'agent-token', SYNTHETIC_VALUE_A));

  // The decoy file the symlink pointed at must never be read into a value
  // or written to by any of the refused operations above.
  assert.equal(readFileSync(decoyTarget, 'utf8'), 'not-a-real-secret-file-content');
}));

test('symlink replacement recovery: remove safely unlinks the symlink (never the target), then create writes a genuine regular file', () => withTempStore((dir, root) => {
  ensureSecretStoreDir(dir);
  const decoyTarget = join(root, 'decoy-secret.txt');
  writeFileSync(decoyTarget, 'decoy-content-must-survive');
  const path = join(dir, 'agent-token.secret.json');
  symlinkSync(decoyTarget, path);

  const removed = removeSecret(dir, 'agent-token');
  assert.equal(removed.reason, 'removed-symlink');
  assert.equal(readFileSync(decoyTarget, 'utf8'), 'decoy-content-must-survive');

  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  const stats = lstatSync(path);
  assert.equal(stats.isSymbolicLink(), false);
  assert.equal(stats.isFile(), true);
  assert.equal(stats.mode & 0o777, 0o600);
}));

// --- concurrent writes fail closed ---

test('a concurrent writer (lock already held) fails closed instead of racing the write', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  ensureSecretStoreDir(dir);
  writeFileSync(join(dir, '.agent-token.lock'), `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' });
  assert.throws(() => replaceSecret(dir, 'agent-token', SYNTHETIC_VALUE_B), (error) => error instanceof SecretLockedError);
  // The original value must be untouched by the rejected concurrent attempt.
  assert.equal(readSecretValueForEnvironment(dir, 'agent-token').value, SYNTHETIC_VALUE_A);
  unlinkSync(join(dir, '.agent-token.lock'));
  replaceSecret(dir, 'agent-token', SYNTHETIC_VALUE_B);
  assert.equal(readSecretValueForEnvironment(dir, 'agent-token').value, SYNTHETIC_VALUE_B);
}));

test('a successful write releases its lock so the next write is not blocked', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  replaceSecret(dir, 'agent-token', SYNTHETIC_VALUE_B);
  assert.equal(readSecretValueForEnvironment(dir, 'agent-token').value, SYNTHETIC_VALUE_B);
}));

// --- removal while active ---

test('removeSecret refuses while a lease is held by a live process (removal while active)', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  const release = acquireSecretLease(dir, 'agent-token');
  assert.throws(() => removeSecret(dir, 'agent-token'), (error) => error instanceof SecretActiveError);
  release();
  removeSecret(dir, 'agent-token');
  assert.equal(getSecretStatus(dir, 'agent-token').status, SECRET_STATUS.MISSING);
}));

test('a stale lease from a dead process is reclaimed rather than blocking forever', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  acquireSecretLease(dir, 'agent-token', { processIsAlive: () => false });
  removeSecret(dir, 'agent-token', { processIsAlive: () => false });
  assert.equal(getSecretStatus(dir, 'agent-token').status, SECRET_STATUS.MISSING);
}));

test('releaseSecretLease on an already-released lease is a safe no-op', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  releaseSecretLease(dir, 'agent-token');
  removeSecret(dir, 'agent-token');
}));

// --- redaction / serialization: status surfaces never carry a value ---

test('getSecretStatus never includes a value field, even serialized', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  const status = getSecretStatus(dir, 'agent-token');
  assert.equal('value' in status, false);
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(SYNTHETIC_VALUE_A), false);
}));

test('listSecretStatuses and verifySecretStoreIntegrity never include a value field', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  createSecret(dir, 'other-token', SYNTHETIC_VALUE_B);
  const list = listSecretStatuses(dir, ['agent-token', 'other-token', 'missing-one']);
  assert.equal(JSON.stringify(list).includes(SYNTHETIC_VALUE_A), false);
  assert.equal(JSON.stringify(list).includes(SYNTHETIC_VALUE_B), false);

  const integrity = verifySecretStoreIntegrity(dir, ['agent-token', 'other-token', 'missing-one']);
  assert.equal(integrity.ok, true);
  assert.equal(JSON.stringify(integrity).includes(SYNTHETIC_VALUE_A), false);
}));

test('rotation-required status is reported without exposing the value', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  markSecretRotationRequired(dir, 'agent-token');
  const status = getSecretStatus(dir, 'agent-token');
  assert.equal(status.status, SECRET_STATUS.ROTATION_REQUIRED);
  assert.equal('value' in status, false);
}));

test('readSecretValueForEnvironment is fail-closed for missing, invalid and rotation-required secrets', () => withTempStore((dir) => {
  assert.equal(readSecretValueForEnvironment(dir, 'nope').ok, false);

  createSecret(dir, 'agent-token', SYNTHETIC_VALUE_A);
  markSecretRotationRequired(dir, 'agent-token');
  const rotationRequired = readSecretValueForEnvironment(dir, 'agent-token');
  assert.equal(rotationRequired.ok, false);
  assert.equal(rotationRequired.value, null);

  ensureSecretStoreDir(dir);
  writeFileSync(join(dir, 'invalid-token.secret.json'), 'corrupt', { mode: 0o600 });
  const invalid = readSecretValueForEnvironment(dir, 'invalid-token');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.value, null);
}));
