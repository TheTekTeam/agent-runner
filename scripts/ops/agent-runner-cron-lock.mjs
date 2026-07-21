import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

function lockError(message, code = 'AGENT_RUNNER_LOCKED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseCronLock(contents) {
  const lines = String(contents || '').trim().split(/\r?\n/);
  if (lines.length < 2 || !/^\d+$/.test(lines[0])) return null;
  const pid = Number(lines[0]);
  const createdAt = lines[1];
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(Date.parse(createdAt))) return null;
  return { pid, createdAt };
}

export function processIsAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

export function acquireRecoverableCronLock(path, dependencies = {}) {
  const fs = {
    closeSync: dependencies.closeSync || closeSync,
    mkdirSync: dependencies.mkdirSync || mkdirSync,
    openSync: dependencies.openSync || openSync,
    readFileSync: dependencies.readFileSync || readFileSync,
    rmSync: dependencies.rmSync || rmSync,
    writeFileSync: dependencies.writeFileSync || writeFileSync,
  };
  const currentPid = dependencies.pid || process.pid;
  const now = dependencies.now || (() => new Date().toISOString());
  const isAlive = dependencies.processIsAlive || processIsAlive;

  fs.mkdirSync(dirname(path), { recursive: true });

  const openOwnedLock = () => {
    const fd = fs.openSync(path, 'wx');
    const ownedContents = `${currentPid}\n${now()}\n`;
    fs.writeFileSync(fd, ownedContents);
    return { fd, ownedContents };
  };

  let owned;
  try {
    owned = openOwnedLock();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;

    let observedContents;
    try {
      observedContents = fs.readFileSync(path, 'utf8');
    } catch (readError) {
      throw lockError(`Runner lock exists but cannot be inspected safely: ${path} (${readError?.code || 'read-failed'})`);
    }

    const observed = parseCronLock(observedContents);
    if (!observed) {
      throw lockError(`Runner lock exists with malformed or ambiguous ownership metadata: ${path}`);
    }
    if (isAlive(observed.pid)) {
      throw lockError(`Runner lock is held by active or unverifiable process ${observed.pid}: ${path}`);
    }

    let confirmedContents;
    try {
      confirmedContents = fs.readFileSync(path, 'utf8');
    } catch (readError) {
      throw lockError(`Stale runner lock changed before recovery and was not removed: ${path} (${readError?.code || 'read-failed'})`);
    }
    if (confirmedContents !== observedContents) {
      throw lockError(`Runner lock ownership changed during stale-lock recovery and was not removed: ${path}`);
    }

    fs.rmSync(path);
    try {
      owned = openOwnedLock();
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') {
        throw lockError(`Runner lock was reacquired during stale-lock recovery: ${path}`);
      }
      throw retryError;
    }
  }

  return () => {
    try { fs.closeSync(owned.fd); } catch { /* ignore */ }
    try {
      if (fs.readFileSync(path, 'utf8') === owned.ownedContents) fs.rmSync(path);
    } catch { /* ignore */ }
  };
}
