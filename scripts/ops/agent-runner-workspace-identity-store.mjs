/**
 * Durable persistence for a recovery attempt's exact implementation
 * worktree/branch identity (#686 spec section 5), layered on top of the
 * byte-locked `claude-runner-state.mjs` `RunnerStateStore` without modifying
 * that file. `scripts/ops/claude-runner-state.mjs` is a ModelSpend import
 * still marked `status: "locked"` in `MIGRATION-MANIFEST.json` — extending
 * its schema in place would require transferring ownership of the whole
 * file for what is otherwise routine schema evolution (adding one column),
 * which `docs/MIGRATION.md` explicitly discourages in favor of a wrapper
 * around the locked file, the same convention `agent-runner-atomic-cron.mjs`
 * and `agent-runner-atomic-candidate-store.mjs` already use around
 * `claude-runner-cron.mjs`.
 *
 * `RunnerStateStore.db` is a plain public instance field (a
 * `node:sqlite` `DatabaseSync`), so this module manages its own additional
 * column and prepared statements directly against it. The column is added
 * lazily (idempotent `PRAGMA table_info` + conditional `ALTER TABLE`, the
 * same pattern the locked file uses internally for its own migrations) the
 * first time a store instance is seen, and every subsequent
 * `RunnerStateStore.allRows('recovery_attempts')` / `.recoveryAttempt(id)`
 * call transparently includes it — no changes to the locked file's read
 * paths are needed for the new column to be visible.
 *
 * Persistence is write-once (`COALESCE` against the existing value): once an
 * attempt's identity is recorded it is never silently replaced or cleared by
 * a later call, matching the write-once contract `claude-runner-state.mjs`
 * already uses for `restricted_handle_digest` (schema v7) for the identical
 * reason -- a workspace-ownership attribution fact must never regress once
 * proven.
 */

const identityColumnEnsured = new WeakSet();

function ensureWorktreeIdentityColumn(store) {
  if (!store?.db || identityColumnEnsured.has(store)) return;
  const columns = new Set(store.db.prepare('PRAGMA table_info(recovery_attempts)').all().map((column) => column.name));
  if (!columns.has('worktree_identity_json')) {
    store.db.exec('ALTER TABLE recovery_attempts ADD COLUMN worktree_identity_json TEXT');
  }
  identityColumnEnsured.add(store);
}

/**
 * Attaches `recordWorktreeIdentity()` to a `RunnerStateStore` instance
 * (idempotent -- safe to call on every store open) so
 * `claude-runner-cron.mjs`'s generic `state.record('recordWorktreeIdentity', ...)`
 * dispatcher can reach it exactly like any other locked-file store method.
 */
export function withWorkspaceIdentitySupport(store) {
  if (!store || typeof store.recordWorktreeIdentity === 'function') return store;
  ensureWorktreeIdentityColumn(store);
  store.recordWorktreeIdentity = ({ attemptId, worktreeIdentity } = {}) => {
    if (!attemptId || !worktreeIdentity) return false;
    ensureWorktreeIdentityColumn(store);
    const result = store.db
      .prepare('UPDATE recovery_attempts SET worktree_identity_json = COALESCE(worktree_identity_json, ?) WHERE attempt_id = ?')
      .run(JSON.stringify(worktreeIdentity), attemptId);
    return result.changes === 1;
  };
  return store;
}
