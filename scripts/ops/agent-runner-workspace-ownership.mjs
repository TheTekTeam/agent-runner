import { spawnSync } from 'node:child_process';

import { prepareImplementationWorkspace } from './claude-runner.mjs';
import { findLinkedOpenPullRequests } from './claude-runner-review-followup.mjs';

/**
 * The typed workspace-ownership inspection boundary (#686). This is the
 * single place a fresh `preflight-direct`/`proceed-command` implementation
 * dispatch must pass through *before* the scheduler commits anything
 * irreversible (the runner-start marker, the `recovery_attempts` claim row,
 * or the status:ready -> status:in-progress label flip). The proven #686
 * failure happened because that ordering was backwards: the claim was
 * committed first, and only the *child* process (running `claude-runner.mjs`
 * in a separate, already-claimed invocation) discovered the conflicting
 * branch — by then the manager preflight was already consumed and the issue
 * already reserved.
 *
 * `prepareImplementationWorkspace()` in claude-runner.mjs remains in place
 * unchanged and is still called by the child before it ever launches Claude
 * — it is the backstop for the residual race between this check and actual
 * dispatch (the workspace could theoretically change in between). This
 * module wraps that same git-level check with attempt-ownership
 * classification so a conflict is attributed to a specific, safe bucket
 * instead of a bare boolean.
 */

const GIT_LEVEL_FAILURE_REASONS = Object.freeze([
  'implementation-base-ref-invalid',
  'implementation-repository-root-unavailable',
  'implementation-base-fetch-failed',
  'implementation-base-ref-unavailable',
  'implementation-origin-head-mismatch',
  'runner-checkout-evidence-unavailable',
]);

const WORKTREE_CONFLICT_FAILURE_REASONS = Object.freeze([
  'implementation-worktree-branch-already-exists',
  'implementation-worktree-already-exists',
]);

function sanitizedAttemptSummary(row = {}) {
  return {
    attemptId: row.attempt_id != null ? String(row.attempt_id) : null,
    resolutionState: row.resolution_state || null,
    outcome: row.outcome || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
  };
}

/**
 * Never let raw stdout/stderr, prompts, or tokens leak into a returned
 * `evidence` object — only booleans, short identifiers, branch/path strings
 * already produced by git plumbing commands, and attempt-row bookkeeping
 * fields that are themselves already redacted at the point they were
 * persisted.
 */
function sanitizedEvidence({
  worktreeIdentity, gitResult, matchingAttempt, otherActiveAttempts, linkedPrs, dirty, headMismatch,
} = {}) {
  return Object.freeze({
    expectedWorktreeName: worktreeIdentity?.name || null,
    expectedBranch: worktreeIdentity?.expectedBranch || null,
    rootPath: gitResult?.rootPath || null,
    worktreePath: gitResult?.worktreePath || null,
    baseRef: gitResult?.baseRef || null,
    baseHead: gitResult?.baseHead || null,
    gitFailureReason: gitResult?.failureReason || null,
    matchingAttempt: matchingAttempt ? sanitizedAttemptSummary(matchingAttempt) : null,
    otherActiveAttemptCount: Array.isArray(otherActiveAttempts) ? otherActiveAttempts.length : 0,
    linkedOpenPrCount: Array.isArray(linkedPrs) ? linkedPrs.length : 0,
    linkedOpenPrNumbers: Array.isArray(linkedPrs) ? linkedPrs.map((pr) => pr.number).filter((n) => Number.isInteger(n)) : [],
    dirty: dirty === true,
    headMismatch: headMismatch === true,
  });
}

function attemptReferencesWorktree(row, worktreeIdentity) {
  // `recovery_attempts` does not currently persist a branch/worktree
  // identity column on the plain row — only `worktree_available`/
  // `branch_available` booleans (the restricted recovery handle store keeps
  // the actual branch/worktree name, and is not queried here). When a row
  // *does* carry an explicit identity (forward-compatible schema, or a
  // caller/test that supplies one), require an exact match. Otherwise fall
  // back to attributing any row the caller already scoped to this exact
  // issue: `buildWorktreeIdentity()` derives the branch deterministically
  // from issue number + source comment, so a worktree conflict on issue N
  // is attributable to one of issue N's own attempts, not a stranger's.
  // Without this fallback every real production conflict would silently
  // degrade to `workspace-ownership-unknown` — the persisted row simply has
  // no column to match against.
  if (row.expected_branch || row.worktree_name) {
    const branch = String(worktreeIdentity?.expectedBranch || '');
    return (Boolean(row.expected_branch) && String(row.expected_branch) === branch)
      || (Boolean(row.worktree_name) && row.worktree_name === worktreeIdentity?.name);
  }
  return true;
}

function attemptIsUnresolved(row) {
  return !row.finished_at && !row.outcome;
}

/**
 * Among every row the caller already scoped to this exact issue, prefer an
 * unresolved (still-active) attempt as the most likely owner of a present
 * conflict; otherwise fall back to the most recently finished/started
 * terminal attempt (spec section 3, "same failed attempt with preserved
 * evidence" / "stale clean workspace with terminal resolved attempt").
 */
function pickMatchingAttempt(activeAttempts, worktreeIdentity) {
  const candidates = activeAttempts.filter((row) => attemptReferencesWorktree(row, worktreeIdentity));
  if (!candidates.length) return null;
  const unresolved = candidates.find((row) => attemptIsUnresolved(row));
  if (unresolved) return unresolved;
  return [...candidates].sort((a, b) => String(b.finished_at || b.started_at || '').localeCompare(String(a.finished_at || a.started_at || '')))[0];
}

/**
 * @param {object} input
 * @param {{name:string, expectedBranch:string}} input.worktreeIdentity
 * @param {string} [input.implementationCheckout]
 * @param {string} input.attemptId - this fresh attempt's own (not yet persisted) id
 * @param {number} input.issueNumber
 * @param {Array<object>} [input.activeAttempts] - every `recovery_attempts` row already scoped to this exact repo/issue (both active and terminal) — the caller must scope by issue, since attribution treats any row here as evidence for a conflict on this issue's worktree
 * @param {Array<object>} [input.pullRequests] - already-fetched open PRs for the repo
 * @param {(identity:object) => Promise<boolean|null>} [input.processProbe]
 * @param {object} [input.env]
 * @param {Function} [input.runner] - spawnSync-compatible git runner (test seam)
 * @param {Function} [input.prepareWorkspace] - test seam over prepareImplementationWorkspace
 * @returns {Promise<import('./agent-runner-workspace-ownership.types.js').WorkspaceOwnershipResult>}
 */
export async function inspectWorkspaceOwnership({
  worktreeIdentity,
  implementationCheckout,
  attemptId,
  issueNumber,
  activeAttempts = [],
  pullRequests = [],
  processProbe = async () => null,
  env = process.env,
  runner = spawnSync,
  prepareWorkspace = prepareImplementationWorkspace,
} = {}) {
  const gitResult = prepareWorkspace({ worktreeIdentity, implementationCheckout, env, runner });

  const otherActiveAttempts = activeAttempts.filter((row) => String(row.attempt_id) !== String(attemptId));
  const linkedPrs = findLinkedOpenPullRequests({ issueNumber, pullRequests });

  if (gitResult.allowed === true) {
    return Object.freeze({
      allowed: true,
      action: 'create',
      ownership: 'new',
      worktreePath: gitResult.worktreePath,
      branchName: worktreeIdentity.expectedBranch,
    });
  }

  // A pre-existing infra/git-level failure (bad base ref, fetch failure,
  // missing checkout, etc.) is not a workspace-ownership conflict — pass it
  // through with its own already-specific reason rather than reclassifying
  // it as an ownership bucket that would suggest a conflicting attempt.
  if (GIT_LEVEL_FAILURE_REASONS.includes(gitResult.failureReason)) {
    return Object.freeze({
      allowed: false,
      reason: gitResult.failureReason,
      safeActions: ['verify-base-ref-and-runner-checkout', 'retry-after-infra-repair'],
      evidence: sanitizedEvidence({ worktreeIdentity, gitResult, otherActiveAttempts, linkedPrs }),
    });
  }

  if (!WORKTREE_CONFLICT_FAILURE_REASONS.includes(gitResult.failureReason)) {
    // Unrecognized git-level result: fail closed as unknown rather than
    // guessing an ownership bucket that isn't warranted by the evidence.
    return Object.freeze({
      allowed: false,
      reason: 'workspace-ownership-unknown',
      safeActions: ['preserve-untouched', 'manual-operator-inspection'],
      evidence: sanitizedEvidence({ worktreeIdentity, gitResult, otherActiveAttempts, linkedPrs }),
    });
  }

  // A conflicting branch/worktree exists. Attribute it to a specific
  // attempt-ownership bucket using the persisted attempt rows this caller
  // supplied, rather than reporting only the bare git conflict.
  const matchingAttempt = pickMatchingAttempt(activeAttempts, worktreeIdentity);

  if (matchingAttempt && String(matchingAttempt.attempt_id) === String(attemptId)) {
    // Same attempt id reusing its own prior workspace — only ever reachable
    // for a caller that reuses an attemptId across calls (a fresh dispatch
    // always mints a new one). Reuse requires every ownership fact to match;
    // any gap fails closed rather than silently reusing.
    return Object.freeze({
      allowed: false,
      reason: 'workspace-owned-by-unresolved-attempt',
      safeActions: ['verify-same-attempt-evidence-before-reuse'],
      evidence: sanitizedEvidence({ worktreeIdentity, gitResult, matchingAttempt, otherActiveAttempts, linkedPrs }),
    });
  }

  if (matchingAttempt && attemptIsUnresolved(matchingAttempt)) {
    let live = null;
    try {
      live = await processProbe({
        processId: matchingAttempt.process_id,
        processBootId: matchingAttempt.process_boot_id,
        processStartTicks: matchingAttempt.process_start_ticks,
        systemdInvocationId: matchingAttempt.systemd_invocation_id,
      });
    } catch {
      live = null;
    }
    const reason = live === true ? 'workspace-owned-by-live-attempt' : 'workspace-owned-by-unresolved-attempt';
    return Object.freeze({
      allowed: false,
      reason,
      safeActions: live === true
        ? ['do-not-dispatch-a-second-worker', 'confirm-authoritative-attempt']
        : ['inspect-preserved-worktree', 'verify-process-and-lease-state', 'explicit-reuse-or-cleanup-decision'],
      evidence: sanitizedEvidence({ worktreeIdentity, gitResult, matchingAttempt, otherActiveAttempts, linkedPrs }),
    });
  }

  if (matchingAttempt) {
    // A resolved (completed/failed/terminal) attempt still owns this exact
    // branch/worktree — preserved evidence from a stale attempt, not a live
    // conflict. Recovery-required: do not reuse or delete silently, and
    // never collapse it into a bare "branch already exists" — a human still
    // needs the owning attempt, dirty/commit state and any linked PR.
    return Object.freeze({
      allowed: false,
      reason: 'workspace-owned-by-unresolved-attempt',
      safeActions: ['inspect-preserved-worktree', 'verify-dirty-and-pr-state', 'explicit-reuse-or-cleanup-decision'],
      evidence: sanitizedEvidence({ worktreeIdentity, gitResult, matchingAttempt, otherActiveAttempts, linkedPrs }),
    });
  }

  // The conflicting branch/worktree exists but no known attempt row
  // references it — a manual or pre-bookkeeping workspace. Fail closed and
  // preserve it untouched; never guess ownership.
  return Object.freeze({
    allowed: false,
    reason: 'workspace-ownership-unknown',
    safeActions: ['preserve-untouched', 'manual-operator-inspection'],
    evidence: sanitizedEvidence({ worktreeIdentity, gitResult, otherActiveAttempts, linkedPrs }),
  });
}

/**
 * Every ownership fact `reuseSameAttemptWorkspace()` requires before a live
 * attempt may reuse its own already-prepared worktree (spec section 3,
 * "same live attempt"). Fails closed on any missing/mismatched fact instead
 * of reusing on partial evidence.
 */
export function evaluateSameAttemptReuse({
  repositoryMatches,
  issueMatches,
  managerPreflightRevisionMatches,
  attemptIdMatches,
  expectedBranchMatches,
  expectedWorktreeMatches,
  leaseMatches,
  processIdentityMatches,
  resumableCheckpointValid,
  worktreeHeadMatches,
} = {}) {
  const facts = {
    repositoryMatches: repositoryMatches === true,
    issueMatches: issueMatches === true,
    managerPreflightRevisionMatches: managerPreflightRevisionMatches === true,
    attemptIdMatches: attemptIdMatches === true,
    expectedBranchMatches: expectedBranchMatches === true,
    expectedWorktreeMatches: expectedWorktreeMatches === true,
    leaseMatches: leaseMatches === true,
    processIdentityOrResumableCheckpoint: processIdentityMatches === true || resumableCheckpointValid === true,
    worktreeHeadMatches: worktreeHeadMatches === true,
  };
  const failedFacts = Object.entries(facts).filter(([, value]) => value !== true).map(([key]) => key);
  return Object.freeze({
    allowed: failedFacts.length === 0,
    failedFacts,
    facts,
  });
}

/**
 * Guarded cleanup precondition for a stale, terminal-resolved, otherwise
 * clean workspace (spec section 3, "stale clean workspace"). Every fact must
 * be independently proven; missing evidence fails closed exactly like
 * disproven evidence. This function only *evaluates* the precondition — it
 * never runs `git reset --hard`, `git clean`, or a branch delete itself.
 */
export function evaluateGuardedCleanupPrecondition({
  noLiveProcess,
  noCurrentLease,
  noUnresolvedClaim,
  noUnpushedCommit,
  noDirtyFiles,
  noLinkedOpenPr,
  identityBelongsToTerminalAttempt,
} = {}) {
  const facts = {
    noLiveProcess: noLiveProcess === true,
    noCurrentLease: noCurrentLease === true,
    noUnresolvedClaim: noUnresolvedClaim === true,
    noUnpushedCommit: noUnpushedCommit === true,
    noDirtyFiles: noDirtyFiles === true,
    noLinkedOpenPr: noLinkedOpenPr === true,
    identityBelongsToTerminalAttempt: identityBelongsToTerminalAttempt === true,
  };
  const failedFacts = Object.entries(facts).filter(([, value]) => value !== true).map(([key]) => key);
  return Object.freeze({
    allowed: failedFacts.length === 0,
    failedFacts,
    facts,
  });
}
