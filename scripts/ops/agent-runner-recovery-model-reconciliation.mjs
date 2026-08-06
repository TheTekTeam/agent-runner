/**
 * Bounded historical reconciliation for `recovery_attempts.model` (#148).
 *
 * Repairs exactly one attempt row whose durable identity was captured
 * before the scheduler's forward fix resolved and persisted the effective
 * model at claim time: the restricted-handle binding authenticates the
 * attempt (agent/harness match, digest verifies), but the persisted `model`
 * column was never filled in, so recomputing the binding from the
 * persisted row alone fails.
 *
 * This is deliberately not a general historical-reconciliation tool. It
 * only ever recognizes and repairs one exact, fixed, "supported" preserved-
 * checkpoint shape -- the one #136's blocked packet `.12` attempt actually
 * left behind (`SUPPORTED_HISTORICAL_ATTEMPT_SHAPE` below). A persisted row
 * that does not match every one of those fixed field values exactly fails
 * closed with `attempt-shape-unsupported`, never attempting a repair. Claim
 * and manager-authority-key identity are part of that exact shape too, but
 * -- unlike the other fixed fields -- they are not literal constants: the
 * persisted row's `claim_id`/`claim_identity_json`/`manager_authority_key`
 * must exactly match the operator's own explicit `expectedClaimId`/
 * `expectedClaimIdentityJson`/`expectedManagerAuthorityKey` evidence when
 * supplied, or be exactly `null` when the caller supplies no such
 * expectation at all (the true pre-manager-authority #136 shape).
 *
 * This module performs no GitHub/network I/O and never receives raw
 * provider output, prompts, credentials or environment values -- callers
 * (the CLI command) gather that evidence externally and pass in only
 * bounded booleans/identifiers/callbacks. It never returns a session id,
 * restricted path, or raw handle JSON -- only the fixed reason codes below,
 * bounded identifiers and digests.
 *
 * Every prerequisite -- the persisted attempt row's exact shape, the
 * restricted handle, the stored binding digest, agent/harness/model
 * identity, manager identity, worktree/checkpoint currency, and remote-
 * publication evidence -- is (re-)read and (re-)verified *after* `BEGIN
 * IMMEDIATE` has acquired this connection's write lock, not merely once
 * before it. A second connection's own `BEGIN IMMEDIATE` against the same
 * database blocks/fails while this one is open (see `agent-runner-recovery-
 * identity-guard.mjs`), so nothing else can mutate the row in the window
 * between "this looked safe to repair" and "the repair was actually
 * written".
 *
 * The captured handle's own `attemptId` field is checked against the exact
 * requested attempt id before its checkpoint identity is ever used to
 * compute or verify a binding digest -- a handle addressed to a different
 * attempt must never be allowed to authenticate this one, even though
 * `readRestrictedRecoveryHandle()`'s default reader already refuses to
 * return a handle whose own `attemptId` disagrees (this is an explicit,
 * redundant check against a caller-supplied `restrictedHandleReader` too).
 *
 * The compare-and-set `UPDATE` itself binds every one of those
 * already-verified fields into its own `WHERE` predicate -- not only
 * `attempt_id`/`model IS NULL`/`agent`/`harness`, but also `repo`,
 * `issue_number`, the manager identity triple, `claim_id`/
 * `claim_identity_json`/`manager_authority_key` (the operator's own
 * `expected*` evidence, or `NULL` when none was supplied), the
 * restricted-handle digest, and the complete recovery-resolution shape
 * (`phase`, `outcome`,
 * `exit_code`, `recovery_eligible`, `recovery_action`,
 * `recovery_attempt_count`, `checkpoint_available`, `session_available`,
 * `worktree_available`, `branch_available`, `pr_available`,
 * `attention_status`, `resolution_state`). A statement that changes any
 * count other than exactly one row is refused as `compare-and-set-
 * conflict` -- there is no scenario in which this repair is allowed to
 * touch more than the single exact row already fully verified above.
 *
 * After the write, the freshly re-read row is verified to exist and be a
 * well-formed object *before* any of its fields are ever read (a missing or
 * malformed readback fails closed with `readback-verification-failed`
 * instead of throwing), its recomputed binding digest is checked, its
 * complete row shape is re-verified, and a full canonical-row comparison
 * against the pre-update row (both with `model` excluded) proves `model` is
 * the *only* column this repair ever changed.
 *
 * Remote-publication evidence is checked twice: once before the guarded
 * transaction even opens (a fast, cheap fail-fast for the common case), and
 * again immediately before COMMIT, after the compare-and-set write and its
 * readback -- the two points explicitly called out in #148's required
 * historical reconciliation contract. Only the second check gates the
 * actual COMMIT; the first exists purely so an already-published checkpoint
 * never causes a database write lock to be acquired for nothing. Either
 * check failing rolls back with `remote-publication-conflict`.
 *
 * Replay (an attempt whose model is already the exact authenticated value)
 * reruns every check above -- including exact shape, handle-attempt
 * identity, manager identity, worktree identity, checkpoint currency and
 * both remote-publication checks -- before returning `reconciliation-
 * replay`. It never short-circuits on "model is already non-null" alone: a
 * replay that skipped re-validation could mask a later divergence (a moved
 * branch, a rewritten checkpoint, an unexpected remote publication) behind
 * an apparently-successful repeat call, and it never writes.
 *
 * Remote-publication evidence is gathered through caller-supplied provider
 * *functions*, invoked here, rather than accepting a pre-computed boolean
 * with a `false` default -- a caller that forgets to wire evidence, or
 * whose evidence read throws/returns something non-boolean, must never
 * silently read as "publication is absent". Only an explicit, literal
 * `false` return counts as "ruled out"; anything else (`true`, `undefined`,
 * a thrown error, a non-boolean value) fails closed as "cannot rule out
 * publication".
 */

import { restrictedHandleBindingDigest, readRestrictedRecoveryHandle, verifyPreservedWorktree } from './claude-runner-recovery-adapter.mjs';
import { isSupportedModelId } from './claude-runner.mjs';

export const RECOVERY_MODEL_RECONCILIATION_FAILURE_CODES = Object.freeze([
  'attempt-not-found',
  'attempt-shape-unsupported',
  'restricted-handle-unavailable',
  'restricted-handle-permissions-unsafe',
  'stored-binding-invalid',
  'persisted-agent-mismatch',
  'persisted-harness-mismatch',
  'persisted-model-conflict',
  'captured-model-invalid',
  'manager-identity-missing',
  'manager-identity-mismatch',
  'worktree-identity-mismatch',
  'checkpoint-not-current',
  'remote-publication-conflict',
  'compare-and-set-conflict',
  'readback-verification-failed',
  'reconciliation-complete',
  'reconciliation-replay',
]);

const SUCCESS_CODES = new Set(['reconciliation-complete', 'reconciliation-replay']);

/**
 * The one exact, fixed preserved-checkpoint shape this command ever repairs
 * -- #136's blocked packet `.12` attempt. Every field is compared exactly
 * (no coercion, no partial match) against the freshly re-read persisted
 * row before any update is attempted, and again bound into the
 * compare-and-set `UPDATE`'s own predicate. A row that came from a
 * different historical incident, however similar, is never in scope for
 * this command. `claimId`/`claimIdentityJson`/`managerAuthorityKey` are not
 * part of this fixed constant -- unlike every other field here, they are
 * compared against the caller's own explicit `expected*` evidence (or
 * required exactly `null` when no such evidence is supplied) by
 * `matchesSupportedHistoricalShape()` below.
 */
export const SUPPORTED_HISTORICAL_ATTEMPT_SHAPE = Object.freeze({
  repo: 'TheTekTeam/agent-runner',
  issueNumber: 136,
  phase: 'starting',
  outcome: 'unknown_failure',
  exitCode: 1,
  recoveryEligible: 0,
  recoveryAction: 'attention_required',
  recoveryAttemptCount: 0,
  checkpointAvailable: 1,
  sessionAvailable: 1,
  worktreeAvailable: 1,
  branchAvailable: 0,
  prAvailable: 0,
  attentionStatus: 'attention_required',
  resolutionState: 'unresolved',
});

function result(code, extra = {}) {
  return { ok: SUCCESS_CODES.has(code), code, ...extra };
}

function canGuardTransactionally(store) {
  return Boolean(store?.db) && typeof store.db.exec === 'function' && typeof store.db.prepare === 'function';
}

/** Only a literal `false` counts as "ruled out"; every other value -- including a thrown read -- fails closed as "cannot rule out". */
function evidenceRulesOutPublication(provider) {
  if (typeof provider !== 'function') return false;
  let value;
  try {
    value = provider();
  } catch {
    return false;
  }
  return value === false;
}

function publicationRuledOut({ remoteBranchPublishedProvider, remotePrPublishedProvider }) {
  return evidenceRulesOutPublication(remoteBranchPublishedProvider) && evidenceRulesOutPublication(remotePrPublishedProvider);
}

/** An unsupplied (`undefined`) expectation means the row must carry no such identity at all. */
function expectedOrNull(expected) {
  return expected === undefined ? null : expected;
}

/**
 * Exact, non-coercive comparison of a freshly re-read persisted attempt row
 * against `SUPPORTED_HISTORICAL_ATTEMPT_SHAPE`. `expectedRepo` is the
 * operator's own explicit `--repo` evidence, cross-checked against both the
 * persisted row and the fixed shape constant -- not a substitute for either.
 * `expectedClaimId`/`expectedClaimIdentityJson`/`expectedManagerAuthorityKey`
 * are the operator's own explicit claim/manager-authority evidence: when
 * supplied, the persisted row must exactly match; when not supplied, the
 * persisted row must carry exactly `null` (the true pre-manager-authority
 * #136 shape).
 */
function matchesSupportedHistoricalShape(attempt, { expectedRepo, expectedClaimId, expectedClaimIdentityJson, expectedManagerAuthorityKey }) {
  const shape = SUPPORTED_HISTORICAL_ATTEMPT_SHAPE;
  return attempt.repo === shape.repo
    && attempt.repo === expectedRepo
    && attempt.issue_number === shape.issueNumber
    && attempt.phase === shape.phase
    && attempt.outcome === shape.outcome
    && attempt.exit_code === shape.exitCode
    && attempt.recovery_eligible === shape.recoveryEligible
    && attempt.recovery_action === shape.recoveryAction
    && attempt.recovery_attempt_count === shape.recoveryAttemptCount
    && attempt.checkpoint_available === shape.checkpointAvailable
    && attempt.session_available === shape.sessionAvailable
    && attempt.worktree_available === shape.worktreeAvailable
    && attempt.branch_available === shape.branchAvailable
    && attempt.pr_available === shape.prAvailable
    && attempt.attention_status === shape.attentionStatus
    && attempt.resolution_state === shape.resolutionState
    && (attempt.claim_id ?? null) === expectedOrNull(expectedClaimId)
    && (attempt.claim_identity_json ?? null) === expectedOrNull(expectedClaimIdentityJson)
    && (attempt.manager_authority_key ?? null) === expectedOrNull(expectedManagerAuthorityKey);
}

/** Every column of a `recovery_attempts` row except `model`, for a canonical before/after "only model changed" comparison. */
function withoutModel(row) {
  const { model, ...rest } = row;
  return rest;
}

/**
 * Repair exactly one attempt's missing persisted model from its
 * authenticated restricted handle, inside one guarded `BEGIN IMMEDIATE`
 * compare-and-set transaction.
 *
 * All `expected*` fields are the operator's already-gathered, explicit
 * evidence for this exact attempt (never inferred from a live scheduler
 * selection) and every one of them must exactly match both the persisted
 * row and the restricted handle before any mutation is attempted.
 * `expectedModel` is required and must already be one of this runner's
 * bounded supported model identifiers -- a reconciliation can only ever
 * repair a row to the exact, supported, handle-authenticated model the
 * operator explicitly named, never an arbitrary captured string.
 */
export function reconcileRecoveryAttemptModel({
  attemptId,
  store,
  outputDir,
  repoRoot,
  expectedRepo,
  expectedAgent,
  expectedHarness,
  expectedModel,
  expectedBranch,
  expectedWorktreeName,
  expectedManagerRevision,
  expectedManagerFingerprint,
  expectedManagerBodyDigest,
  expectedClaimId,
  expectedClaimIdentityJson,
  expectedManagerAuthorityKey,
  remoteBranchPublishedProvider,
  remotePrPublishedProvider,
  restrictedHandleReader = readRestrictedRecoveryHandle,
  worktreeVerifier = verifyPreservedWorktree,
  gitRunner,
} = {}) {
  if (!attemptId || typeof attemptId !== 'string') return result('attempt-not-found', { attemptId: null });
  if (!store || typeof store.recoveryAttempt !== 'function' || !canGuardTransactionally(store)) {
    return result('attempt-not-found', { attemptId });
  }
  if (!isSupportedModelId(expectedModel)) return result('captured-model-invalid', { attemptId });

  const publicationProviders = { remoteBranchPublishedProvider, remotePrPublishedProvider };
  const shapeExpectations = { expectedRepo, expectedClaimId, expectedClaimIdentityJson, expectedManagerAuthorityKey };

  // First publication check -- before the guarded transaction (and its
  // write lock) is even opened. Purely a fast fail-fast for the common
  // "checkpoint was already published" case; the write path below never
  // trusts this alone.
  if (!publicationRuledOut(publicationProviders)) return result('remote-publication-conflict', { attemptId });

  store.db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const attempt = store.recoveryAttempt(attemptId);
    if (!attempt) return result('attempt-not-found', { attemptId });

    if (!matchesSupportedHistoricalShape(attempt, shapeExpectations)) {
      return result('attempt-shape-unsupported', { attemptId });
    }

    const read = restrictedHandleReader(outputDir, attemptId);
    if (!read.permissionSafe) return result('restricted-handle-permissions-unsafe', { attemptId });
    if (!read.available || !read.handle) return result('restricted-handle-unavailable', { attemptId });
    const handle = read.handle;

    // Explicit, redundant check: a handle addressed to a different attempt
    // id must never authenticate this one, even against a caller-supplied
    // restrictedHandleReader that does not already enforce this itself.
    if (handle.attemptId !== attemptId) return result('stored-binding-invalid', { attemptId });

    if (!attempt.restricted_handle_digest) return result('stored-binding-invalid', { attemptId });
    const capturedBindingDigest = restrictedHandleBindingDigest({
      attemptId,
      agent: handle.agent,
      model: handle.model,
      harness: handle.harness,
      checkpointHead: handle.checkpointHead,
      checkpointStatusFingerprint: handle.checkpointStatusFingerprint,
    });
    if (capturedBindingDigest !== attempt.restricted_handle_digest) return result('stored-binding-invalid', { attemptId });

    if (!attempt.agent || attempt.agent !== handle.agent || attempt.agent !== expectedAgent) {
      return result('persisted-agent-mismatch', { attemptId });
    }
    if (!attempt.harness || attempt.harness !== handle.harness || attempt.harness !== expectedHarness) {
      return result('persisted-harness-mismatch', { attemptId });
    }

    const candidateModel = handle.model;
    if (!isSupportedModelId(candidateModel)) return result('captured-model-invalid', { attemptId });
    if (candidateModel !== expectedModel) return result('captured-model-invalid', { attemptId });

    if (attempt.model != null && attempt.model !== candidateModel) {
      return result('persisted-model-conflict', { attemptId });
    }

    if (!attempt.manager_preflight_revision || !attempt.manager_preflight_fingerprint || !attempt.manager_preflight_body_digest) {
      return result('manager-identity-missing', { attemptId });
    }
    if (attempt.manager_preflight_revision !== expectedManagerRevision
      || attempt.manager_preflight_fingerprint !== expectedManagerFingerprint
      || attempt.manager_preflight_body_digest !== expectedManagerBodyDigest) {
      return result('manager-identity-mismatch', { attemptId });
    }

    if (!handle.expectedBranch || !handle.worktreeName
      || handle.expectedBranch !== expectedBranch || handle.worktreeName !== expectedWorktreeName) {
      return result('worktree-identity-mismatch', { attemptId });
    }

    const preserved = worktreeVerifier({ handle, repoRoot, runner: gitRunner });
    if (!preserved.preservedWorktreeCurrent || !preserved.checkpointCurrent) {
      return result('checkpoint-not-current', { attemptId });
    }

    // Every prerequisite above has now been re-established under this
    // transaction's own write lock, against freshly re-read evidence -- not
    // merely against evidence captured (or captured on a prior call) before
    // the lock was acquired.
    if (attempt.model != null) {
      // Replay: rerun the full publication check (both providers, invoked
      // fresh) rather than trusting the pre-transaction check above -- a
      // replay must never short-circuit on "model already non-null" alone.
      if (!publicationRuledOut(publicationProviders)) return result('remote-publication-conflict', { attemptId });
      return result('reconciliation-replay', { attemptId, model: attempt.model, bindingDigest: attempt.restricted_handle_digest });
    }

    const shape = SUPPORTED_HISTORICAL_ATTEMPT_SHAPE;
    const update = store.db.prepare(`
      UPDATE recovery_attempts SET model = ?
      WHERE attempt_id = ? AND model IS NULL
        AND agent = ? AND harness = ?
        AND repo = ? AND issue_number = ?
        AND manager_preflight_revision = ? AND manager_preflight_fingerprint = ? AND manager_preflight_body_digest = ?
        AND claim_id IS ? AND claim_identity_json IS ? AND manager_authority_key IS ?
        AND restricted_handle_digest = ?
        AND phase = ? AND outcome = ? AND exit_code = ?
        AND recovery_eligible = ? AND recovery_action = ? AND recovery_attempt_count = ?
        AND checkpoint_available = ? AND session_available = ? AND worktree_available = ?
        AND branch_available = ? AND pr_available = ?
        AND attention_status = ? AND resolution_state = ?
    `).run(
      candidateModel,
      attemptId, expectedAgent, expectedHarness,
      expectedRepo, shape.issueNumber,
      expectedManagerRevision, expectedManagerFingerprint, expectedManagerBodyDigest,
      expectedOrNull(expectedClaimId), expectedOrNull(expectedClaimIdentityJson), expectedOrNull(expectedManagerAuthorityKey),
      attempt.restricted_handle_digest,
      shape.phase, shape.outcome, shape.exitCode,
      shape.recoveryEligible, shape.recoveryAction, shape.recoveryAttemptCount,
      shape.checkpointAvailable, shape.sessionAvailable, shape.worktreeAvailable,
      shape.branchAvailable, shape.prAvailable,
      shape.attentionStatus, shape.resolutionState,
    );
    if (update.changes !== 1) return result('compare-and-set-conflict', { attemptId });

    const readback = store.db.prepare('SELECT * FROM recovery_attempts WHERE attempt_id = ?').get(attemptId);
    // Missing/malformed readback is checked -- and fails closed with the
    // fixed code -- *before* any of its fields are ever accessed, never
    // allowed to throw an uncaught TypeError out of this function.
    if (!readback || typeof readback !== 'object') return result('readback-verification-failed', { attemptId });

    const recomputedDigest = restrictedHandleBindingDigest({
      attemptId,
      agent: readback.agent,
      model: readback.model,
      harness: readback.harness,
      checkpointHead: handle.checkpointHead,
      checkpointStatusFingerprint: handle.checkpointStatusFingerprint,
    });
    if (readback.model !== candidateModel
      || recomputedDigest !== readback.restricted_handle_digest
      || !matchesSupportedHistoricalShape(readback, shapeExpectations)) {
      return result('readback-verification-failed', { attemptId });
    }
    // Canonical complete-row comparison (every column except `model`)
    // proves this repair changed model and nothing else -- including
    // columns never bound into the CAS predicate above (timestamps, retry
    // bookkeeping, etc).
    if (JSON.stringify(withoutModel(attempt)) !== JSON.stringify(withoutModel(readback))) {
      return result('readback-verification-failed', { attemptId });
    }

    // Second publication check -- immediately before COMMIT, after the
    // compare-and-set write and its readback. If a branch or PR appeared in
    // the window since the first check, this repair must not be finalized.
    if (!publicationRuledOut(publicationProviders)) return result('remote-publication-conflict', { attemptId });

    store.db.exec('COMMIT');
    committed = true;
    return result('reconciliation-complete', { attemptId, model: readback.model, bindingDigest: recomputedDigest });
  } finally {
    if (!committed) {
      try { store.db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
  }
}
