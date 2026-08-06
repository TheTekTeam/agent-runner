/**
 * Write-once agent/model/harness identity guard for `recovery_attempts`
 * (#148). `scripts/ops/claude-runner-state.mjs` is locked to its ModelSpend
 * import (see `docs/MIGRATION.md`), so this wraps `recordRecoveryAttempt()`
 * from the outside -- the same convention `agent-runner-workspace-identity-
 * store.mjs` already uses around the same locked file -- instead of editing
 * the locked file in place.
 *
 * `recordRecoveryAttempt()`'s `agent`/`model`/`harness`/`repo`/`issue_number`
 * columns are frozen at the initial `INSERT`: they are entirely absent from
 * its `ON CONFLICT DO UPDATE SET` clause, so a later write can never erase,
 * change, or *fill* an already-persisted (even null) value in those columns
 * -- but the SQL layer also silently no-ops a later write that disagrees
 * with an already-persisted value, with no signal that a conflict was even
 * attempted. This guard makes that fail closed instead: a later call whose
 * non-null agent/model/harness genuinely disagrees with an already-persisted
 * non-null value throws a typed `RecoveryAttemptIdentityConflictError` (one
 * of the fixed `persisted-agent-mismatch` / `persisted-harness-mismatch` /
 * `persisted-model-conflict` codes) instead of proceeding, so the caller's
 * own store-write wrapper (`state.record()` in `claude-runner-cron.mjs`)
 * surfaces it as a genuine failure rather than an invisible no-op. The same
 * fail-closed treatment applies to a later write that would *fill* an
 * already-persisted null value in one of these columns: a row whose
 * agent/model/harness are all still null is not yet identity-anchored (an
 * ordinary write's first non-null values there are that row's first
 * identity capture, not a fill, and never conflicts), but once any one of
 * the three is known the row is anchored, and a later write can never fill
 * a still-null sibling column either -- only a dedicated historical
 * reconciliation path (`reconcileRecoveryAttemptModel()`, entirely outside
 * this guard) may ever do that.
 *
 * The check-then-write is performed inside one `BEGIN IMMEDIATE`
 * transaction on the store's own connection: the read that decides whether
 * a conflict exists and the write it gates happen under the same
 * connection-held write lock, so a second writer on another connection can
 * never interleave a conflicting commit between this guard's read and its
 * write. `BEGIN IMMEDIATE` also serializes concurrent callers across
 * connections: a second connection's own `BEGIN IMMEDIATE` blocks/fails
 * until the first has committed or rolled back.
 *
 * After every write, this guard re-reads the row and verifies a fixed,
 * complete immutable-identity projection: the frozen columns above, plus a
 * second, write-once-*fillable* set (`restricted_handle_digest`, manager
 * identity, claim/preflight identity) that uses `COALESCE` semantics in the
 * locked file's own `ON CONFLICT` clause -- null -> non-null exactly once is
 * legitimate there (the restricted handle/manager identity is often only
 * known after the initial claim-time `INSERT`), but a once-set non-null
 * value can never change.
 *
 * For a genuinely *fresh* row (nothing persisted for this attempt id before
 * this write), the post-write readback must exist and exactly match the
 * incoming agent/model/harness, repository/issue identity, manager identity
 * and restricted-handle digest -- not merely "no earlier value to compare
 * against". For an *existing* row, every frozen column must be byte-for-byte
 * identical before and after (proving an ordinary write can never fill a
 * previously-null frozen identity field, only a dedicated reconciliation
 * path may ever do that), and every fillable column that already carried a
 * non-null value must remain exactly unchanged. A missing or malformed
 * post-write readback -- not only a mismatching one -- is treated exactly
 * like a mismatch: `readback-verification-failed`, rolled back, never a
 * thrown internal error.
 *
 * `withRecoveryIdentityGuard` only ever wraps a store it can actually guard
 * end to end. A store exposing `recordRecoveryAttempt` but missing any of: a
 * non-empty, length-bounded `attemptId` on the incoming write, a
 * `recoveryAttempt()` reader, or a transactional `db.exec`/`db.prepare`
 * pair, is "recovery-capable but unverifiable" and must never write --
 * calling `recordRecoveryAttempt()` on it throws `unverifiable-recovery-
 * store` instead of silently falling through to an unguarded write. A store
 * with no `recordRecoveryAttempt` at all is simply not recovery-capable and
 * is returned unwrapped, unchanged.
 *
 * A `null`/`undefined` incoming value never conflicts (it simply carries no
 * new identity claim).
 *
 * The thrown error's message and `code` are the only information it
 * carries -- never the attempt id, the persisted value, or the incoming
 * value -- because `createStateRecorder()`'s `record()` wrapper in
 * `claude-runner-cron.mjs` folds `error.message` into its own bounded
 * `errors`/`statePersistenceErrors` diagnostics, which must never carry raw
 * identity values (#148).
 */

export class RecoveryAttemptIdentityConflictError extends Error {
  constructor(code) {
    super(`recovery attempt identity conflict: ${code}`);
    this.name = 'RecoveryAttemptIdentityConflictError';
    this.code = code;
  }
}

const IDENTITY_FIELDS = Object.freeze([
  ['agent', 'persisted-agent-mismatch'],
  ['model', 'persisted-model-conflict'],
  ['harness', 'persisted-harness-mismatch'],
]);

// Frozen at INSERT: recordRecoveryAttempt()'s own ON CONFLICT DO UPDATE SET
// clause never touches these columns at all, so once a first row exists for
// an attempt id they can never be changed -- and, critically, can never be
// *filled* from null to non-null either -- by any later ordinary write.
const FROZEN_IDENTITY_FIELDS = Object.freeze(['agent', 'model', 'harness', 'repo', 'issue_number']);

// Write-once-fillable: COALESCE(existing, incoming) in the locked file's own
// ON CONFLICT SET clause -- null -> non-null exactly once is legitimate, but
// a once-set non-null value can never change.
const FILLABLE_IDENTITY_FIELDS = Object.freeze([
  'restricted_handle_digest',
  'manager_preflight_revision', 'manager_preflight_fingerprint', 'manager_preflight_body_digest',
  'manager_authority_key', 'claim_identity_json', 'preflight_identity_json',
]);

const IMMUTABLE_PROJECTION_FIELDS = Object.freeze([...FROZEN_IDENTITY_FIELDS, ...FILLABLE_IDENTITY_FIELDS]);

// The exact fixed set of columns a fresh (first-ever) write's post-write
// readback must match byte-for-byte against the incoming payload. Claim/
// preflight identity are intentionally excluded here -- their persisted
// *_identity_json columns are a normalized encoding of the incoming raw
// claim/preflight fields, not a literal copy of any single incoming key --
// but they remain covered by the fillable-once check on every later write.
const FRESH_ROW_MATCH_FIELDS = Object.freeze([
  'agent', 'model', 'harness', 'repo', 'issue_number',
  'manager_preflight_revision', 'manager_preflight_fingerprint', 'manager_preflight_body_digest',
  'manager_authority_key', 'restricted_handle_digest',
]);

const INCOMING_KEY_BY_COLUMN = Object.freeze({
  agent: 'agent', model: 'model', harness: 'harness', repo: 'repo', issue_number: 'issueNumber',
  manager_preflight_revision: 'managerPreflightRevision',
  manager_preflight_fingerprint: 'managerPreflightFingerprint',
  manager_preflight_body_digest: 'managerPreflightBodyDigest',
  manager_authority_key: 'managerAuthorityKey',
  restricted_handle_digest: 'restrictedHandleDigest',
});

function incomingValueForColumn(attempt, column) {
  return (attempt ? attempt[INCOMING_KEY_BY_COLUMN[column]] : null) || null;
}

const MAX_ATTEMPT_ID_LENGTH = 300;

const GUARD_MARKER = Symbol('agentRunnerRecoveryIdentityGuarded');

function canGuardTransactionally(store) {
  return Boolean(store?.db) && typeof store.db.exec === 'function' && typeof store.db.prepare === 'function';
}

function isBoundedAttemptId(attemptId) {
  return typeof attemptId === 'string' && attemptId.length > 0 && attemptId.length <= MAX_ATTEMPT_ID_LENGTH;
}

function immutableProjection(row) {
  const projection = {};
  for (const field of IMMUTABLE_PROJECTION_FIELDS) projection[field] = row ? (row[field] ?? null) : null;
  return projection;
}

export function withRecoveryIdentityGuard(store) {
  if (!store || store[GUARD_MARKER]) return store;
  if (typeof store.recordRecoveryAttempt !== 'function') return store;
  const original = store.recordRecoveryAttempt.bind(store);
  store.recordRecoveryAttempt = (attempt = {}) => {
    const attemptId = attempt?.attemptId;
    // A recovery-capable store that cannot be guarded end to end (no bounded
    // attemptId on this write, no reader, or no transactional db) must never
    // write -- falling through to an unguarded call would silently defeat
    // every invariant this module exists to enforce.
    if (!isBoundedAttemptId(attemptId) || typeof store.recoveryAttempt !== 'function' || !canGuardTransactionally(store)) {
      throw new RecoveryAttemptIdentityConflictError('unverifiable-recovery-store');
    }

    store.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const persisted = store.recoveryAttempt(attemptId);
      const isFreshRow = !persisted;
      if (persisted) {
        // A row whose agent/model/harness are *all* still null has no
        // identity anchored yet -- an ordinary write's first real identity
        // values are simply that row's first identity capture, not a fill.
        // But once any one of the three is known, the row is anchored: a
        // later write can never fill a still-null sibling field either,
        // only a dedicated historical reconciliation path (outside this
        // guard) may ever do that.
        const anchored = IDENTITY_FIELDS.some(([field]) => persisted[field] != null);
        for (const [field, code] of IDENTITY_FIELDS) {
          const persistedValue = persisted[field];
          const incomingValue = attempt[field];
          if (incomingValue == null) continue;
          if (persistedValue != null) {
            if (incomingValue !== persistedValue) throw new RecoveryAttemptIdentityConflictError(code);
          } else if (anchored) {
            throw new RecoveryAttemptIdentityConflictError(code);
          }
        }
      }
      const before = immutableProjection(persisted);
      const outcome = original(attempt);
      const afterRow = store.recoveryAttempt(attemptId);
      // A write that is supposed to persist a row must always be able to be
      // read back -- a missing or malformed post-write readback is never
      // "nothing to verify"; it fails exactly like a genuine mismatch.
      if (!afterRow || typeof afterRow !== 'object') {
        throw new RecoveryAttemptIdentityConflictError('readback-verification-failed');
      }
      const after = immutableProjection(afterRow);

      if (isFreshRow) {
        for (const field of FRESH_ROW_MATCH_FIELDS) {
          if (after[field] !== incomingValueForColumn(attempt, field)) {
            throw new RecoveryAttemptIdentityConflictError('readback-verification-failed');
          }
        }
      } else {
        for (const field of FROZEN_IDENTITY_FIELDS) {
          // Frozen columns can never change, and can never be filled from
          // null to non-null by an ordinary write either -- this readback
          // proves that invariant held for this exact write.
          if (before[field] !== after[field]) {
            throw new RecoveryAttemptIdentityConflictError('readback-verification-failed');
          }
        }
        for (const field of FILLABLE_IDENTITY_FIELDS) {
          if (before[field] != null && before[field] !== after[field]) {
            throw new RecoveryAttemptIdentityConflictError('readback-verification-failed');
          }
        }
      }
      store.db.exec('COMMIT');
      committed = true;
      return outcome;
    } finally {
      if (!committed) {
        try { store.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
      }
    }
  };
  store[GUARD_MARKER] = true;
  return store;
}
