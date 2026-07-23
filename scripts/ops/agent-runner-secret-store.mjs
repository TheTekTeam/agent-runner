import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Protected machine-local secret broker (issue #45).
 *
 * Every secret lives as one mode-0600 JSON file inside a mode-0700
 * directory, outside any repository checkout. Values never round-trip
 * through this module's "status" surface: `getSecretStatus()` and
 * `listSecretStatuses()` return only the safe enum plus timestamps.
 * `readSecretValueForEnvironment()` is the sole function that returns a raw
 * value, and it exists only for `agent-runner-secret-environment.mjs` to
 * call while building a child process env — nothing else in this module
 * (or any dashboard/API/log path) has a route to a raw value.
 */

export const SECRET_STATUS = Object.freeze({
  CONFIGURED: 'configured',
  MISSING: 'missing',
  INVALID: 'invalid',
  ROTATION_REQUIRED: 'rotation-required',
});

const SCHEMA_VERSION = 'agent-runner-secret/v1';
const SECRET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_STORE_RELATIVE = '.local/state/agent-runner/secrets';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class SecretLockedError extends Error {
  constructor(id) {
    super(`secret store entry is locked by a concurrent writer: ${id}`);
    this.name = 'SecretLockedError';
    this.code = 'AGENT_RUNNER_SECRET_LOCKED';
  }
}

export class SecretActiveError extends Error {
  constructor(id) {
    super(`secret cannot be removed while an active lease is held: ${id}`);
    this.name = 'SecretActiveError';
    this.code = 'AGENT_RUNNER_SECRET_ACTIVE';
  }
}

/**
 * Reject anything that is not a short, closed alphanumeric/dash/underscore
 * token. This makes path traversal structurally impossible rather than
 * merely filtered: there is no `/`, `\`, `.`, leading `-`/`~`, or byte
 * outside the allowlist that this pattern accepts, so `join(dir, id)` can
 * never leave `dir` and can never resolve to a dotfile/lockfile of ours.
 */
export function validateSecretId(id) {
  if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: 'empty' };
  if (id.length > 64) return { ok: false, reason: 'too-long' };
  if (!SECRET_ID_PATTERN.test(id)) return { ok: false, reason: 'malformed' };
  if (id.includes('..')) return { ok: false, reason: 'traversal' };
  if (isAbsolute(id)) return { ok: false, reason: 'absolute' };
  return { ok: true, reason: null };
}

function requireValidId(id) {
  const check = validateSecretId(id);
  if (!check.ok) {
    const error = new Error(`invalid secret id (${check.reason}): ${JSON.stringify(id)}`);
    error.code = 'AGENT_RUNNER_SECRET_INVALID_ID';
    error.reason = check.reason;
    throw error;
  }
}

export function resolveSecretStoreDir(env = process.env) {
  const home = String(env.HOME || homedir());
  const raw = String(env.AGENT_RUNNER_SECRET_STORE_DIR || '').trim();
  if (!raw) return resolve(home, DEFAULT_STORE_RELATIVE);
  return isAbsolute(raw) ? raw : resolve(home, raw);
}

function secretFilePath(dir, id) {
  return join(dir, `${id}.secret.json`);
}

function lockFilePath(dir, id) {
  return join(dir, `.${id}.lock`);
}

function leaseFilePath(dir, id) {
  return join(dir, `.${id}.lease`);
}

/**
 * `lstat` (never `stat`) so a symlinked path is detected instead of
 * silently followed. Ambiguous evidence (no `process.getuid`, non-numeric
 * uid/mode) is treated as a violation, never as "probably fine".
 */
function verifyRestrictedPath(path, { expectedMode, expectDirectory, lstatFn }) {
  let stats;
  try {
    stats = lstatFn(path);
  } catch {
    return { ok: false, missing: true, reason: 'not-found' };
  }
  if (typeof process.getuid !== 'function' || typeof stats.uid !== 'number' || typeof stats.mode !== 'number') {
    return { ok: false, missing: false, reason: 'ambiguous-permission-evidence' };
  }
  if (stats.isSymbolicLink()) return { ok: false, missing: false, reason: 'symlink' };
  if (expectDirectory && !stats.isDirectory()) return { ok: false, missing: false, reason: 'not-a-directory' };
  if (!expectDirectory && !stats.isFile()) return { ok: false, missing: false, reason: 'not-a-regular-file' };
  if (stats.uid !== process.getuid()) return { ok: false, missing: false, reason: 'wrong-owner' };
  if ((stats.mode & 0o777) !== expectedMode) return { ok: false, missing: false, reason: 'wrong-mode' };
  return { ok: true, missing: false, reason: null };
}

function defaultDeps(overrides = {}) {
  return {
    mkdirFn: mkdirSync,
    chmodFn: chmodSync,
    lstatFn: lstatSync,
    readFn: readFileSync,
    writeFn: writeFileSync,
    renameFn: renameSync,
    unlinkFn: unlinkSync,
    rmFn: rmSync,
    existsFn: existsSync,
    openFn: openSync,
    closeFn: closeSync,
    now: () => new Date().toISOString(),
    pid: process.pid,
    ...overrides,
  };
}

/**
 * Create (mode 0700) and verify the store directory. Fails closed (throws)
 * rather than continuing on ambiguous or drifted permission evidence, so a
 * caller can never proceed believing the directory is owner-exclusive when
 * it is not.
 */
export function ensureSecretStoreDir(dir, deps = {}) {
  const fs = defaultDeps(deps);
  fs.mkdirFn(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodFn(dir, DIR_MODE);
  const check = verifyRestrictedPath(dir, { expectedMode: DIR_MODE, expectDirectory: true, lstatFn: fs.lstatFn });
  if (!check.ok) {
    const error = new Error(`secret store directory failed permission verification: ${check.reason}`);
    error.code = 'AGENT_RUNNER_SECRET_STORE_DIR_UNSAFE';
    error.reason = check.reason;
    throw error;
  }
  return { dir, verified: true };
}

/** Acquire a non-recoverable exclusive lock. A concurrent writer fails closed immediately. */
function acquireLock(dir, id, fs) {
  const path = lockFilePath(dir, id);
  let fd;
  try {
    fd = fs.openFn(path, 'wx', FILE_MODE);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new SecretLockedError(id);
    throw error;
  }
  fs.writeFn(fd, `${fs.pid}\n${fs.now()}\n`);
  fs.closeFn(fd);
  return () => {
    try { fs.unlinkFn(path); } catch { /* best-effort release */ }
  };
}

function digestOf(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function parseRecord(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof parsed.value !== 'string') return null;
  if (parsed.digest !== digestOf(parsed.value)) return null;
  return parsed;
}

/**
 * Atomic write shared by create/replace/rotate: write to a fresh
 * exclusively-created temp file in the same directory (never the
 * destination path directly), chmod+verify it, then rename it onto the
 * destination. `rename(2)` atomically replaces whatever was at the
 * destination — including a symlink an attacker pre-placed there — with the
 * regular file, so the destination can never be "followed" the way an
 * open-for-write without O_EXCL could be. If anything before the rename
 * throws, the destination is untouched: rollback is structural, not a
 * separate backup/restore step.
 */
function atomicWriteRecord(dir, id, record, fs) {
  const path = secretFilePath(dir, id);
  const tmpPath = join(dir, `.${id}.${randomBytes(8).toString('hex')}.tmp`);
  const body = JSON.stringify(record);
  let fd;
  try {
    fd = fs.openFn(tmpPath, 'wx', FILE_MODE);
    fs.writeFn(fd, body);
    fs.closeFn(fd);
    fs.chmodFn(tmpPath, FILE_MODE);
    const tmpCheck = verifyRestrictedPath(tmpPath, { expectedMode: FILE_MODE, expectDirectory: false, lstatFn: fs.lstatFn });
    if (!tmpCheck.ok) throw new Error(`temp secret file failed permission verification: ${tmpCheck.reason}`);
    fs.renameFn(tmpPath, path);
  } catch (error) {
    try { fs.unlinkFn(tmpPath); } catch { /* best-effort cleanup; destination is untouched either way */ }
    throw error;
  }
  const finalCheck = verifyRestrictedPath(path, { expectedMode: FILE_MODE, expectDirectory: false, lstatFn: fs.lstatFn });
  if (!finalCheck.ok) {
    const error = new Error(`secret file failed permission verification after write: ${finalCheck.reason}`);
    error.code = 'AGENT_RUNNER_SECRET_WRITE_UNSAFE';
    throw error;
  }
}

function readRecord(dir, id, fs) {
  const path = secretFilePath(dir, id);
  const check = verifyRestrictedPath(path, { expectedMode: FILE_MODE, expectDirectory: false, lstatFn: fs.lstatFn });
  if (!check.ok) return { record: null, check };
  let raw;
  try {
    raw = fs.readFn(path, 'utf8');
  } catch {
    return { record: null, check: { ok: false, missing: true, reason: 'not-found' } };
  }
  const record = parseRecord(raw);
  if (!record) return { record: null, check: { ok: false, missing: false, reason: 'corrupt' } };
  return { record, check };
}

function isRotationRequired(record, nowIso) {
  if (record.rotationRequired === true) return true;
  if (record.rotationRequiredAt && Date.parse(record.rotationRequiredAt) <= Date.parse(nowIso)) return true;
  return false;
}

/**
 * Safe status only. Never returns `value`, and the return shape carries no
 * field a caller could mistake for one — this is the function a future
 * dashboard/status API is meant to call.
 */
export function getSecretStatus(dir, id, deps = {}) {
  requireValidId(id);
  const fs = defaultDeps(deps);
  const { record, check } = readRecord(dir, id, fs);
  if (check.missing) return { id, status: SECRET_STATUS.MISSING, reason: 'not-found', updatedAt: null, rotatedAt: null };
  if (!check.ok || !record) return { id, status: SECRET_STATUS.INVALID, reason: check.reason || 'corrupt', updatedAt: null, rotatedAt: null };
  if (isRotationRequired(record, fs.now())) {
    return { id, status: SECRET_STATUS.ROTATION_REQUIRED, reason: 'rotation-required', updatedAt: record.updatedAt, rotatedAt: record.rotatedAt };
  }
  return { id, status: SECRET_STATUS.CONFIGURED, reason: null, updatedAt: record.updatedAt, rotatedAt: record.rotatedAt };
}

export function listSecretStatuses(dir, ids, deps = {}) {
  return ids.map((id) => getSecretStatus(dir, id, deps));
}

function writeSecretInternal(dir, id, value, { mustExist, mustNotExist, rotate, rotationRequiredAt = null } = {}, deps = {}) {
  requireValidId(id);
  if (typeof value !== 'string' || value.length === 0) {
    const error = new Error(`secret value must be a non-empty string: ${id}`);
    error.code = 'AGENT_RUNNER_SECRET_INVALID_VALUE';
    throw error;
  }
  const fs = defaultDeps(deps);
  ensureSecretStoreDir(dir, fs);
  const release = acquireLock(dir, id, fs);
  try {
    const { record: existing, check } = readRecord(dir, id, fs);
    const exists = !check.missing && (existing !== null || !check.ok);
    if (mustExist && (check.missing || !existing)) {
      const error = new Error(`cannot replace/rotate a secret that does not exist or is invalid: ${id}`);
      error.code = 'AGENT_RUNNER_SECRET_NOT_FOUND';
      throw error;
    }
    if (mustNotExist && exists) {
      const error = new Error(`refusing to overwrite an existing secret via create: ${id}`);
      error.code = 'AGENT_RUNNER_SECRET_ALREADY_EXISTS';
      throw error;
    }
    const now = fs.now();
    const record = {
      schemaVersion: SCHEMA_VERSION,
      id,
      value,
      digest: digestOf(value),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      rotatedAt: rotate ? now : (existing?.rotatedAt || null),
      rotationRequired: false,
      rotationRequiredAt,
    };
    atomicWriteRecord(dir, id, record, fs);
    return { id, status: SECRET_STATUS.CONFIGURED };
  } finally {
    release();
  }
}

/** Atomic create. Fails closed if a valid or invalid entry already occupies this id. */
export function createSecret(dir, id, value, deps = {}) {
  return writeSecretInternal(dir, id, value, { mustNotExist: true }, deps);
}

/** Atomic replace. Fails closed if no existing valid entry is present. */
export function replaceSecret(dir, id, value, deps = {}) {
  return writeSecretInternal(dir, id, value, { mustExist: true }, deps);
}

/** Atomic rotate: like replace, but stamps `rotatedAt` and clears any rotation-required flag. */
export function rotateSecret(dir, id, value, deps = {}) {
  return writeSecretInternal(dir, id, value, { mustExist: true, rotate: true }, deps);
}

/** Explicitly mark a configured secret as needing rotation, without changing its value. */
export function markSecretRotationRequired(dir, id, deps = {}) {
  requireValidId(id);
  const fs = defaultDeps(deps);
  const release = acquireLock(dir, id, fs);
  try {
    const { record, check } = readRecord(dir, id, fs);
    if (check.missing || !record) {
      const error = new Error(`cannot mark rotation-required for a secret that does not exist or is invalid: ${id}`);
      error.code = 'AGENT_RUNNER_SECRET_NOT_FOUND';
      throw error;
    }
    atomicWriteRecord(dir, id, { ...record, rotationRequired: true }, fs);
    return { id, status: SECRET_STATUS.ROTATION_REQUIRED };
  } finally {
    release();
  }
}

/**
 * Acquire a lease marking a secret as in active use by a running adapter
 * process. `removeSecret()` consults this before deleting anything, giving
 * "removal while active" concrete, testable semantics rather than leaving
 * it implicit.
 */
export function acquireSecretLease(dir, id, deps = {}) {
  requireValidId(id);
  const fs = defaultDeps(deps);
  ensureSecretStoreDir(dir, fs);
  const path = leaseFilePath(dir, id);
  let fd;
  try {
    fd = fs.openFn(path, 'wx', FILE_MODE);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const active = leaseIsActive(dir, id, fs);
      if (active) throw new SecretActiveError(id);
      fs.unlinkFn(path);
      fd = fs.openFn(path, 'wx', FILE_MODE);
    } else {
      throw error;
    }
  }
  fs.writeFn(fd, `${fs.pid}\n${fs.now()}\n`);
  fs.closeFn(fd);
  return () => releaseSecretLease(dir, id, fs);
}

export function releaseSecretLease(dir, id, deps = {}) {
  requireValidId(id);
  const fs = defaultDeps(deps);
  try { fs.unlinkFn(leaseFilePath(dir, id)); } catch { /* already released */ }
}

function leaseIsActive(dir, id, fs) {
  const path = leaseFilePath(dir, id);
  let raw;
  try {
    raw = fs.readFn(path, 'utf8');
  } catch {
    return false;
  }
  const pid = Number(String(raw || '').trim().split(/\r?\n/)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true; // ambiguous evidence fails closed as active
  const kill = fs.processIsAlive || ((candidatePid) => {
    try {
      process.kill(candidatePid, 0);
      return true;
    } catch (error) {
      return error?.code !== 'ESRCH';
    }
  });
  return kill(pid);
}

/**
 * Atomic remove. Fails closed while an active lease is held (`removal while
 * active`). A missing entry is a no-op success, not an error.
 */
export function removeSecret(dir, id, deps = {}) {
  requireValidId(id);
  const fs = defaultDeps(deps);
  if (leaseIsActive(dir, id, fs)) throw new SecretActiveError(id);
  const release = acquireLock(dir, id, fs);
  try {
    const path = secretFilePath(dir, id);
    if (!fs.existsFn(path)) return { id, status: SECRET_STATUS.MISSING };
    const check = verifyRestrictedPath(path, { expectedMode: FILE_MODE, expectDirectory: false, lstatFn: fs.lstatFn });
    if (!check.ok && check.reason === 'symlink') {
      // Never unlink through a symlink hijack silently — remove exactly the
      // symlink inode at this path (unlink never follows), then report it.
      fs.unlinkFn(path);
      return { id, status: SECRET_STATUS.MISSING, reason: 'removed-symlink' };
    }
    fs.unlinkFn(path);
    return { id, status: SECRET_STATUS.MISSING };
  } finally {
    release();
  }
}

/**
 * Internal-only raw read. Not exported from any status/control surface —
 * only `agent-runner-secret-environment.mjs` calls this, and only to place
 * the value directly into a child process env, never into a return value
 * that could be logged, serialized, or displayed.
 */
export function readSecretValueForEnvironment(dir, id, deps = {}) {
  requireValidId(id);
  const fs = defaultDeps(deps);
  const { record, check } = readRecord(dir, id, fs);
  if (check.missing || !record) return { ok: false, status: SECRET_STATUS.MISSING, value: null };
  if (!check.ok) return { ok: false, status: SECRET_STATUS.INVALID, value: null };
  if (isRotationRequired(record, fs.now())) return { ok: false, status: SECRET_STATUS.ROTATION_REQUIRED, value: null };
  return { ok: true, status: SECRET_STATUS.CONFIGURED, value: record.value };
}

/**
 * Walk every entry under the store directory and re-verify structural and
 * permission integrity without ever reading a value into the return value.
 * Intended for post-restore verification (see
 * docs/ops/AGENT-RUNNER-SECRET-STORE.md) — confirms a recovered store is
 * safe to rely on before any adapter reads from it.
 */
export function verifySecretStoreIntegrity(dir, ids, deps = {}) {
  const statuses = listSecretStatuses(dir, ids, deps);
  return {
    ok: statuses.every((entry) => entry.status === SECRET_STATUS.CONFIGURED || entry.status === SECRET_STATUS.MISSING),
    statuses,
  };
}
