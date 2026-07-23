import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import { resolveAgentSettingsPath } from './agent-runner-agent-settings.mjs';

/**
 * Atomic, optimistically-versioned control settings document store
 * (issue #46).
 *
 * This module owns *write* access to the same file
 * `agent-runner-agent-settings.mjs` already reads
 * (`resolveAgentSettingsPath()` — reused here, not re-implemented, so the
 * two modules can never resolve a different path for the same override).
 * `agent-runner-agent-settings.mjs` re-reads the file fresh on every call
 * and only ever looks at `raw.agents[<agentId>]`, so a write committed here
 * is visible to the very next `getAgentSettings()`/`isAgentRoutable()` call
 * with no cache to invalidate and no service restart required.
 *
 * The document adds `schemaVersion`, `revision` and `updatedAt` alongside
 * the pre-existing `agents` map; `agent-runner-agent-settings.mjs` ignores
 * unknown top-level keys, so this is a purely additive, backward-compatible
 * extension of the #40 schema.
 */

export const CONTROL_SETTINGS_SCHEMA_VERSION = 'agent-runner-control-settings/v1';
const FILE_MODE = 0o600;
const MAX_HISTORY_ENTRIES = 20;

export class ControlSettingsLockedError extends Error {
  constructor() {
    super('control settings store is locked by a concurrent writer');
    this.name = 'ControlSettingsLockedError';
    this.code = 'AGENT_RUNNER_CONTROL_SETTINGS_LOCKED';
  }
}

export class ControlSettingsStaleRevisionError extends Error {
  constructor(expected, actual) {
    super(`stale write rejected: expected revision ${expected}, current revision is ${actual}`);
    this.name = 'ControlSettingsStaleRevisionError';
    this.code = 'AGENT_RUNNER_CONTROL_SETTINGS_STALE_REVISION';
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

export class ControlSettingsRollbackUnavailableError extends Error {
  constructor(targetRevision) {
    super(`no retained history entry for revision ${targetRevision}`);
    this.name = 'ControlSettingsRollbackUnavailableError';
    this.code = 'AGENT_RUNNER_CONTROL_SETTINGS_ROLLBACK_UNAVAILABLE';
    this.targetRevision = targetRevision;
  }
}

export class ControlSettingsInvalidDocumentError extends Error {
  constructor(reason) {
    super(`control settings document failed validation: ${reason}`);
    this.name = 'ControlSettingsInvalidDocumentError';
    this.code = 'AGENT_RUNNER_CONTROL_SETTINGS_INVALID_DOCUMENT';
    this.reason = reason;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export { resolveAgentSettingsPath as resolveControlSettingsPath };

function historyDir(path) {
  return `${path}.history`;
}

function historyFilePath(path, revision) {
  return join(historyDir(path), `${revision}.json`);
}

function lockFilePath(path) {
  return `${path}.lock`;
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
    rmFn: undefined,
    existsFn: existsSync,
    openFn: openSync,
    closeFn: closeSync,
    readdirFn: readdirSync,
    now: () => new Date().toISOString(),
    pid: process.pid,
    ...overrides,
  };
}

function emptyDocument() {
  return { schemaVersion: CONTROL_SETTINGS_SCHEMA_VERSION, revision: 0, updatedAt: null, agents: {} };
}

/**
 * Validate the minimal structural contract this store depends on. Deeper
 * per-field/per-agent validation (the allowlist, lifecycle rules, catalogue
 * membership) belongs to `agent-runner-control-instances.mjs`, not here —
 * this store is agnostic to what an "agent" entry contains.
 */
export function validateControlSettingsDocument(doc) {
  if (!isPlainObject(doc)) return { ok: false, reason: 'document-not-an-object' };
  if (doc.schemaVersion !== CONTROL_SETTINGS_SCHEMA_VERSION) return { ok: false, reason: 'schema-version-mismatch' };
  if (!Number.isInteger(doc.revision) || doc.revision < 0) return { ok: false, reason: 'invalid-revision' };
  if (!isPlainObject(doc.agents)) return { ok: false, reason: 'agents-not-an-object' };
  return { ok: true, reason: null };
}

function readDocument(path, fs) {
  if (!fs.existsFn(path)) return { doc: emptyDocument(), found: false, parseError: null };
  let raw;
  try {
    raw = fs.readFn(path, 'utf8');
  } catch (error) {
    return { doc: emptyDocument(), found: false, parseError: error.message };
  }
  if (!raw.trim()) return { doc: emptyDocument(), found: true, parseError: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { doc: null, found: true, parseError: error.message };
  }
  // A pre-existing #40 file (agents-only, no schemaVersion/revision) is
  // adopted at revision 0 rather than rejected — this store must not brick
  // an operator's existing agent-settings.json on first use.
  if (isPlainObject(parsed) && parsed.schemaVersion === undefined && isPlainObject(parsed.agents)) {
    return { doc: { schemaVersion: CONTROL_SETTINGS_SCHEMA_VERSION, revision: 0, updatedAt: null, agents: parsed.agents }, found: true, parseError: null };
  }
  const check = validateControlSettingsDocument(parsed);
  if (!check.ok) return { doc: null, found: true, parseError: check.reason };
  return { doc: parsed, found: true, parseError: null };
}

/** Read-only load: current document, revision, and whether the file exists/parses. */
export function loadControlSettingsDocument(path = resolveAgentSettingsPath(), deps = {}) {
  const fs = defaultDeps(deps);
  const { doc, found, parseError } = readDocument(path, fs);
  return { path, doc, revision: doc?.revision ?? null, found, parseError };
}

function acquireLock(path, fs) {
  const lockPath = lockFilePath(path);
  let fd;
  try {
    fd = fs.openFn(lockPath, 'wx', FILE_MODE);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ControlSettingsLockedError();
    throw error;
  }
  fs.writeFn(fd, `${fs.pid}\n${fs.now()}\n`);
  fs.closeFn(fd);
  return () => {
    try { fs.unlinkFn(lockPath); } catch { /* best-effort release */ }
  };
}

function atomicWriteJson(path, value, fs) {
  const dir = resolve(path, '..');
  fs.mkdirFn(dir, { recursive: true });
  const tmpPath = join(dir, `.${randomBytes(8).toString('hex')}.control-settings.tmp`);
  const body = JSON.stringify(value, null, 2);
  let fd;
  try {
    fd = fs.openFn(tmpPath, 'wx', FILE_MODE);
    fs.writeFn(fd, body);
    fs.closeFn(fd);
    fs.chmodFn(tmpPath, FILE_MODE);
    fs.renameFn(tmpPath, path);
  } catch (error) {
    try { fs.unlinkFn(tmpPath); } catch { /* destination untouched either way */ }
    throw error;
  }
  fs.chmodFn(path, FILE_MODE);
}

function pruneHistory(path, fs) {
  const dir = historyDir(path);
  let entries;
  try {
    entries = fs.readdirFn(dir);
  } catch {
    return;
  }
  const revisions = entries
    .map((name) => Number(name.replace(/\.json$/, '')))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => b - a);
  for (const revision of revisions.slice(MAX_HISTORY_ENTRIES)) {
    try { fs.unlinkFn(historyFilePath(path, revision)); } catch { /* best-effort prune */ }
  }
}

function saveHistorySnapshot(path, doc, fs) {
  if (!doc || doc.revision === 0) return; // nothing meaningful to roll back to yet
  const dir = historyDir(path);
  fs.mkdirFn(dir, { recursive: true });
  atomicWriteJson(historyFilePath(path, doc.revision), doc, fs);
  pruneHistory(path, fs);
}

/**
 * Read-modify-write under an exclusive lock, with optimistic-concurrency
 * protection layered on top: `expectedRevision` (when not `null`/
 * `undefined`) must match the revision on disk at write time or the write
 * is rejected *before* anything is touched, leaving the last known good
 * revision exactly as it was. `mutate(currentAgents)` returns the new
 * `agents` map only — the store itself owns `schemaVersion`/`revision`/
 * `updatedAt` bookkeeping so a caller cannot accidentally desynchronize it.
 */
export function replaceControlSettingsDocument({
  path = resolveAgentSettingsPath(),
  expectedRevision = null,
  mutate,
  deps = {},
} = {}) {
  if (typeof mutate !== 'function') throw new Error('replaceControlSettingsDocument requires a mutate function');
  const fs = defaultDeps(deps);
  const release = acquireLock(path, fs);
  try {
    const { doc: current, parseError } = readDocument(path, fs);
    if (parseError) throw new ControlSettingsInvalidDocumentError(parseError);
    if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new ControlSettingsStaleRevisionError(expectedRevision, current.revision);
    }
    const nextAgents = mutate(current.agents);
    if (!isPlainObject(nextAgents)) throw new ControlSettingsInvalidDocumentError('mutate-did-not-return-an-agents-object');
    const nextDoc = {
      schemaVersion: CONTROL_SETTINGS_SCHEMA_VERSION,
      revision: current.revision + 1,
      updatedAt: fs.now(),
      agents: nextAgents,
    };
    const check = validateControlSettingsDocument(nextDoc);
    if (!check.ok) throw new ControlSettingsInvalidDocumentError(check.reason);
    saveHistorySnapshot(path, current, fs);
    atomicWriteJson(path, nextDoc, fs);
    return { doc: nextDoc, revision: nextDoc.revision, previousRevision: current.revision };
  } finally {
    release();
  }
}

/**
 * Restore a previously retained revision's `agents` content as a brand new
 * (monotonically higher) revision. Rollback is itself a normal write — it
 * never reuses or rewinds a revision number, so optimistic-concurrency
 * expectations held by any other reader remain valid, and the rolled-back-
 * from state is itself preserved in history.
 */
export function rollbackControlSettings({
  path = resolveAgentSettingsPath(),
  targetRevision,
  deps = {},
} = {}) {
  if (!Number.isInteger(targetRevision) || targetRevision < 0) {
    throw new ControlSettingsRollbackUnavailableError(targetRevision);
  }
  const fs = defaultDeps(deps);
  const release = acquireLock(path, fs);
  try {
    const { doc: current, parseError } = readDocument(path, fs);
    if (parseError) throw new ControlSettingsInvalidDocumentError(parseError);
    if (targetRevision === current.revision) {
      throw new ControlSettingsRollbackUnavailableError(targetRevision);
    }
    let targetDoc;
    if (targetRevision === 0) {
      targetDoc = emptyDocument();
    } else {
      let raw;
      try {
        raw = fs.readFn(historyFilePath(path, targetRevision), 'utf8');
      } catch {
        throw new ControlSettingsRollbackUnavailableError(targetRevision);
      }
      try {
        targetDoc = JSON.parse(raw);
      } catch {
        throw new ControlSettingsRollbackUnavailableError(targetRevision);
      }
    }
    const check = validateControlSettingsDocument({ ...targetDoc, revision: 0 });
    if (!check.ok) throw new ControlSettingsRollbackUnavailableError(targetRevision);
    saveHistorySnapshot(path, current, fs);
    const nextDoc = {
      schemaVersion: CONTROL_SETTINGS_SCHEMA_VERSION,
      revision: current.revision + 1,
      updatedAt: fs.now(),
      agents: targetDoc.agents,
    };
    atomicWriteJson(path, nextDoc, fs);
    return { doc: nextDoc, revision: nextDoc.revision, restoredFromRevision: targetRevision, previousRevision: current.revision };
  } finally {
    release();
  }
}

/** Bounded list of retained history revisions (most recent first), for a rollback picker. */
export function listControlSettingsHistory(path = resolveAgentSettingsPath(), deps = {}) {
  const fs = defaultDeps(deps);
  let entries;
  try {
    entries = fs.readdirFn(historyDir(path));
  } catch {
    return [];
  }
  return entries
    .map((name) => Number(name.replace(/\.json$/, '')))
    .filter((value) => Number.isInteger(value))
    .sort((a, b) => b - a);
}
