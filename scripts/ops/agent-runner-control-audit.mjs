import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * Control-service audit trail (issue #46).
 *
 * Every entry carries actor, source, time, revision and changed *field
 * names* only. `appendControlAuditEntry()` has no parameter through which a
 * caller could pass a value for it to persist — `changedFields` is
 * constrained to short field-name strings, never arbitrary objects — so a
 * value cannot reach this file even by caller mistake. This mirrors
 * `agent-runner-secret-store.mjs`'s `validateSecretId`: the unsafe shape is
 * structurally unrepresentable, not merely filtered after the fact.
 */

const DEFAULT_AUDIT_RELATIVE = '.local/state/agent-runner/control-audit.jsonl';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_FIELD_NAME_LENGTH = 128;
const MAX_READ_LIMIT = 500;

export function resolveControlAuditPath(env = process.env) {
  const home = String(env.HOME || homedir());
  const raw = String(env.AGENT_RUNNER_CONTROL_AUDIT_PATH || '').trim();
  if (!raw) return resolve(home, DEFAULT_AUDIT_RELATIVE);
  return isAbsolute(raw) ? raw : resolve(home, raw);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sanitizeChangedFields(changedFields) {
  return (Array.isArray(changedFields) ? changedFields : [])
    .map((field) => String(field))
    .filter((field) => field.length > 0 && field.length <= MAX_FIELD_NAME_LENGTH);
}

function defaultDeps(overrides = {}) {
  return {
    mkdirFn: mkdirSync,
    chmodFn: chmodSync,
    existsFn: existsSync,
    openFn: openSync,
    closeFn: closeSync,
    appendFn: appendFileSync,
    readFn: readFileSync,
    now: () => new Date().toISOString(),
    randomId: () => randomUUID(),
    ...overrides,
  };
}

function ensureAuditFile(path, fs) {
  const dir = resolve(path, '..');
  fs.mkdirFn(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodFn(dir, DIR_MODE);
  if (!fs.existsFn(path)) {
    fs.closeFn(fs.openFn(path, 'a', FILE_MODE));
  }
  fs.chmodFn(path, FILE_MODE);
}

/**
 * Append one audit entry. `actor`, `source` and `action` are short
 * machine-readable identifiers (operator id, `control-api`, `settings.
 * replace`, etc.) — never free-form text that could embed a submitted
 * value. `reason`, when present, must likewise be a bounded reason code,
 * never an echo of request input.
 */
export function appendControlAuditEntry({
  actor,
  source,
  action,
  revision = null,
  changedFields = [],
  outcome = 'ok',
  reason = null,
  path = resolveControlAuditPath(),
  deps = {},
} = {}) {
  if (!isNonEmptyString(actor)) throw new Error('appendControlAuditEntry requires actor');
  if (!isNonEmptyString(source)) throw new Error('appendControlAuditEntry requires source');
  if (!isNonEmptyString(action)) throw new Error('appendControlAuditEntry requires action');

  const fs = defaultDeps(deps);
  ensureAuditFile(path, fs);

  const entry = Object.freeze({
    id: fs.randomId(),
    at: fs.now(),
    actor: String(actor),
    source: String(source),
    action: String(action),
    revision: revision === null || revision === undefined ? null : Number(revision),
    changedFields: sanitizeChangedFields(changedFields),
    outcome: String(outcome),
    reason: reason ? String(reason).slice(0, 256) : null,
  });
  fs.appendFn(path, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
  return entry;
}

/** Most-recent-first bounded read. Every entry is already value-free by construction. */
export function readControlAuditEntries({ path = resolveControlAuditPath(), limit = 50, deps = {} } = {}) {
  const fs = defaultDeps(deps);
  if (!fs.existsFn(path)) return [];
  const raw = fs.readFn(path, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // skip a corrupt line rather than fail the whole read
    }
  }
  const bounded = Math.max(1, Math.min(Number(limit) || 50, MAX_READ_LIMIT));
  return entries.slice(-bounded).reverse();
}
