import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
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
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Operator authentication and secure session handling (issue #46).
 *
 * Deliberately separate from the #45 provider-secret store: an operator
 * credential is not an adapter credential, it never flows into a child
 * process environment, and this module never calls
 * `readSecretValueForEnvironment()`. The credential verifier file stores a
 * scrypt hash and salt only — never the password — mode `0600`, following
 * the same restrictive-file convention as `agent-runner-secret-store.mjs`.
 *
 * Sessions are held in-memory only (never written to disk), so a service
 * restart always requires a fresh login — a deliberate, documented
 * trade-off in favour of never persisting a session token anywhere.
 */

const SCHEMA_VERSION = 'agent-runner-control-operator/v1';
const DEFAULT_CREDENTIAL_RELATIVE = '.local/state/agent-runner/control-operator.json';
const FILE_MODE = 0o600;
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_ID_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;

export class OperatorNotConfiguredError extends Error {
  constructor() {
    super('no operator credential is configured');
    this.name = 'OperatorNotConfiguredError';
    this.code = 'AGENT_RUNNER_CONTROL_OPERATOR_NOT_CONFIGURED';
  }
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
    existsFn: existsSync,
    openFn: openSync,
    closeFn: closeSync,
    scryptFn: (password, salt) => scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS),
    randomBytesFn: randomBytes,
    now: () => new Date().toISOString(),
    ...overrides,
  };
}

export function resolveOperatorCredentialPath(env = process.env) {
  const home = String(env.HOME || homedir());
  const raw = String(env.AGENT_RUNNER_CONTROL_OPERATOR_PATH || '').trim();
  if (!raw) return resolve(home, DEFAULT_CREDENTIAL_RELATIVE);
  return isAbsolute(raw) ? raw : resolve(home, raw);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function atomicWriteJson(path, value, fs) {
  const dir = resolve(path, '..');
  fs.mkdirFn(dir, { recursive: true });
  const tmpPath = join(dir, `.${fs.randomBytesFn(8).toString('hex')}.control-operator.tmp`);
  let fd;
  try {
    fd = fs.openFn(tmpPath, 'wx', FILE_MODE);
    fs.writeFn(fd, JSON.stringify(value, null, 2));
    fs.closeFn(fd);
    fs.chmodFn(tmpPath, FILE_MODE);
    fs.renameFn(tmpPath, path);
  } catch (error) {
    try { fs.unlinkFn(tmpPath); } catch { /* destination untouched either way */ }
    throw error;
  }
  fs.chmodFn(path, FILE_MODE);
}

/**
 * Bootstrap/rotate the operator credential. This is a local, machine-local
 * write path only — it is never exposed as an HTTP route (there would be
 * no way to authenticate a request to change the credential before one
 * exists), matching the "operator authentication" requirement's implicit
 * assumption of a pre-provisioned credential.
 */
export function setOperatorCredential({
  username,
  password,
  path = resolveOperatorCredentialPath(),
  deps = {},
} = {}) {
  if (!isNonEmptyString(username)) throw new Error('setOperatorCredential requires a username');
  if (!isNonEmptyString(password) || password.length < 12) {
    throw new Error('setOperatorCredential requires a password of at least 12 characters');
  }
  const fs = defaultDeps(deps);
  const salt = fs.randomBytesFn(16).toString('hex');
  const hash = fs.scryptFn(password, Buffer.from(salt, 'hex')).toString('hex');
  const record = {
    schemaVersion: SCHEMA_VERSION,
    username: username.trim(),
    algorithm: 'scrypt',
    salt,
    hash,
    updatedAt: fs.now(),
  };
  atomicWriteJson(path, record, fs);
  return { username: record.username, updatedAt: record.updatedAt };
}

function timingSafeEqualHex(candidateHex, expectedHex) {
  const candidate = Buffer.from(String(candidateHex || ''), 'hex');
  const expected = Buffer.from(String(expectedHex || ''), 'hex');
  if (candidate.length !== expected.length) {
    // Compare against a same-length zero buffer so a length mismatch does
    // not short-circuit before any comparison work happens.
    try { timingSafeEqual(candidate, Buffer.alloc(candidate.length)); } catch { /* still falls through to false */ }
    return false;
  }
  return timingSafeEqual(candidate, expected);
}

/**
 * Verify a submitted username/password against the stored verifier. Never
 * returns or logs the submitted password; a failure carries only a
 * bounded, generic reason code.
 */
export function verifyOperatorCredential({
  username,
  password,
  path = resolveOperatorCredentialPath(),
  deps = {},
} = {}) {
  const fs = defaultDeps(deps);
  if (!fs.existsFn(path)) return { ok: false, reason: 'operator-not-configured' };
  let record;
  try {
    record = JSON.parse(fs.readFn(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'operator-credential-corrupt' };
  }
  if (!record || record.schemaVersion !== SCHEMA_VERSION || typeof record.hash !== 'string' || typeof record.salt !== 'string') {
    return { ok: false, reason: 'operator-credential-corrupt' };
  }
  if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
    return { ok: false, reason: 'operator-credentials-required' };
  }
  const usernameMatches = username.trim() === record.username;
  const computedHash = fs.scryptFn(password, Buffer.from(record.salt, 'hex')).toString('hex');
  const passwordMatches = timingSafeEqualHex(computedHash, record.hash);
  if (!usernameMatches || !passwordMatches) return { ok: false, reason: 'operator-credentials-invalid' };
  return { ok: true, reason: null, username: record.username };
}

/**
 * In-memory session store. `csrfToken` is issued alongside the session id
 * and returned in the login response body (never solely in the cookie) —
 * the double-submit pattern this API's CSRF module relies on.
 */
export function createControlSessionStore({ ttlMs = DEFAULT_SESSION_TTL_MS, now = () => Date.now(), randomBytesFn = randomBytes } = {}) {
  const sessions = new Map();

  function purgeExpired(currentMs = now()) {
    for (const [id, session] of sessions) {
      if (session.expiresAtMs <= currentMs) sessions.delete(id);
    }
  }

  return {
    create(username) {
      purgeExpired();
      const id = randomBytesFn(SESSION_ID_BYTES).toString('hex');
      const csrfToken = randomBytesFn(CSRF_TOKEN_BYTES).toString('hex');
      const createdAtMs = now();
      const session = { id, username, csrfToken, createdAtMs, expiresAtMs: createdAtMs + ttlMs };
      sessions.set(id, session);
      return session;
    },
    get(id) {
      purgeExpired();
      if (!isNonEmptyString(id)) return null;
      const session = sessions.get(id);
      if (!session) return null;
      if (session.expiresAtMs <= now()) {
        sessions.delete(id);
        return null;
      }
      return session;
    },
    destroy(id) {
      sessions.delete(id);
    },
    size() {
      purgeExpired();
      return sessions.size;
    },
  };
}

const SESSION_COOKIE_NAME = 'agent_runner_control_session';

export function buildSessionCookie(sessionId, { maxAgeSeconds = Math.floor(DEFAULT_SESSION_TTL_MS / 1000) } = {}) {
  return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function buildSessionClearCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function parseSessionCookie(cookieHeader = '') {
  const parts = String(cookieHeader || '').split(';');
  for (const part of parts) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === SESSION_COOKIE_NAME) return rest.join('=').trim() || null;
  }
  return null;
}

export { SESSION_COOKIE_NAME };
