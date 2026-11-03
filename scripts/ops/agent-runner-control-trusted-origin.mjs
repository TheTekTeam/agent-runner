import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCHEMA_VERSION = 'agent-runner-control-trusted-origin/v1';
const DEFAULT_RELATIVE_PATH = '.config/agent-runner/control-trusted-origin.json';
const FILE_MODE = 0o600;

function defaultDeps(overrides = {}) {
  return {
    existsFn: existsSync,
    lstatFn: lstatSync,
    readFn: readFileSync,
    mkdirFn: mkdirSync,
    openFn: openSync,
    writeFn: writeFileSync,
    closeFn: closeSync,
    chmodFn: chmodSync,
    renameFn: renameSync,
    unlinkFn: unlinkSync,
    randomBytesFn: randomBytes,
    ...overrides,
  };
}

export function resolveTrustedProxyOriginPath(env = process.env) {
  const home = String(env.HOME || homedir());
  return resolve(home, DEFAULT_RELATIVE_PATH);
}

export function normalizeTrustedProxyOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error('trusted proxy origin must be a non-empty, whitespace-free HTTPS origin');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('trusted proxy origin must be a valid absolute HTTPS origin');
  }
  if (url.protocol !== 'https:') throw new Error('trusted proxy origin must use https');
  if (!url.hostname || url.hostname.includes('*')) throw new Error('trusted proxy origin must use an exact hostname without wildcards');
  if (url.username || url.password) throw new Error('trusted proxy origin must not contain userinfo');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('trusted proxy origin must not contain a path, query, or fragment');
  if (value.endsWith('/')) throw new Error('trusted proxy origin must be expressed as an origin without a trailing slash');
  return url.origin;
}

export function readTrustedProxyOrigin({ path = resolveTrustedProxyOriginPath(), deps = {} } = {}) {
  const fs = defaultDeps(deps);
  if (!fs.existsFn(path)) return null;
  const stat = fs.lstatFn(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('trusted proxy origin configuration must be a regular file, not a symlink');
  if ((stat.mode & 0o777) !== FILE_MODE) throw new Error('trusted proxy origin configuration must have mode 0600');
  let record;
  try {
    record = JSON.parse(fs.readFn(path, 'utf8'));
  } catch {
    throw new Error('trusted proxy origin configuration is not valid JSON');
  }
  if (!record || record.schemaVersion !== SCHEMA_VERSION || typeof record.origin !== 'string') {
    throw new Error('trusted proxy origin configuration has an unsupported schema');
  }
  return normalizeTrustedProxyOrigin(record.origin);
}

export function setTrustedProxyOrigin({ origin, path = resolveTrustedProxyOriginPath(), deps = {} } = {}) {
  const fs = defaultDeps(deps);
  const normalized = normalizeTrustedProxyOrigin(origin);
  const parent = dirname(path);
  fs.mkdirFn(parent, { recursive: true, mode: 0o700 });
  if (fs.existsFn(path)) {
    const stat = fs.lstatFn(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('refusing to replace non-regular trusted proxy origin configuration');
  }
  const tmp = join(parent, `.${fs.randomBytesFn(8).toString('hex')}.trusted-origin.tmp`);
  let fd;
  try {
    fd = fs.openFn(tmp, 'wx', FILE_MODE);
    fs.writeFn(fd, JSON.stringify({ schemaVersion: SCHEMA_VERSION, origin: normalized }, null, 2));
    fs.closeFn(fd);
    fd = undefined;
    fs.chmodFn(tmp, FILE_MODE);
    fs.renameFn(tmp, path);
    fs.chmodFn(path, FILE_MODE);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeFn(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkFn(tmp); } catch { /* best effort */ }
    throw error;
  }
  return normalized;
}

export function removeTrustedProxyOrigin({ path = resolveTrustedProxyOriginPath(), deps = {} } = {}) {
  const fs = defaultDeps(deps);
  if (!fs.existsFn(path)) return false;
  const stat = fs.lstatFn(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('refusing to remove non-regular trusted proxy origin configuration');
  fs.unlinkFn(path);
  return true;
}
