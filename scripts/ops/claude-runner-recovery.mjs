import { createHash } from 'node:crypto';

export const RECOVERY_POLICY_REVISION = 'runner-recovery-v1';
export const TERMINAL_OUTCOMES = Object.freeze([
  'completed', 'plan_only_awaiting_approval', 'turn_limit_exhausted', 'quota_paused',
  'rate_limited', 'transient_provider_or_network_failure', 'validation_failed',
  'permission_or_auth_failure', 'process_crash_or_signal', 'checkpoint_incompatible',
  'unknown_failure', 'orphaned_active_claim',
]);

export const DEFAULT_RECOVERY_POLICY = Object.freeze({
  revision: RECOVERY_POLICY_REVISION,
  rateLimitAttemptCap: 3,
  transientAttemptCap: 2,
  resumeAttemptCap: 1,
  validationAttemptCap: 1,
  baseBackoffMs: 60_000,
  maxBackoffMs: 15 * 60_000,
});

const LEGACY_REASONS = Object.freeze({
  'turn-limit-exhausted': 'turn_limit_exhausted',
  'plan-only-awaiting-approval': 'plan_only_awaiting_approval',
  'awaiting-plan-approval': 'plan_only_awaiting_approval',
  awaiting_plan_approval: 'plan_only_awaiting_approval',
  'quota-paused': 'quota_paused',
  'rate-limited': 'rate_limited',
  'validation-failed': 'validation_failed',
  'permission-or-auth-failure': 'permission_or_auth_failure',
  'process-crash-or-signal': 'process_crash_or_signal',
  'checkpoint-incompatible': 'checkpoint_incompatible',
  'unknown-failure': 'unknown_failure',
});

export function normalizeTerminalOutcome(reason) {
  const candidate = LEGACY_REASONS[reason] || String(reason || '').trim().toLowerCase().replaceAll('-', '_');
  return TERMINAL_OUTCOMES.includes(candidate) ? candidate : 'unknown_failure';
}

/**
 * The bounded-attempt cap `decideRecovery()`'s own `retry()` helper enforces
 * for a given terminal outcome, re-derivable from a persisted row rather
 * than trusted from the `recovery_eligible` flag alone (#698 round 4,
 * finding 1: evidence-based liveness classification must independently
 * reconstruct "bounded retry policy", not assume a stale write already
 * proved it). `quota_paused`/`retry_after_quota_preflight` has no
 * attempt-count cap in `decideRecovery` — it is bounded by a known quota
 * reset deadline instead, so `null` here means "not attempt-count bounded",
 * not "unbounded"; callers must still require a valid future deadline for
 * that outcome.
 */
export function recoveryAttemptCapForOutcome(outcome, policy = DEFAULT_RECOVERY_POLICY) {
  switch (outcome) {
    case 'rate_limited': return policy.rateLimitAttemptCap;
    case 'transient_provider_or_network_failure': return policy.transientAttemptCap;
    case 'turn_limit_exhausted': return policy.resumeAttemptCap;
    case 'validation_failed': return policy.validationAttemptCap;
    default: return null;
  }
}

function forbidden(reason, nextAction) {
  return { policyRevision: RECOVERY_POLICY_REVISION, eligible: false, action: 'attention_required', status: 'forbidden', reason, nextAction };
}

function ownershipProven(evidence) {
  return evidence.processOwner === false && evidence.conflictingLease === false && evidence.ownershipAmbiguous === false;
}

function headroomProven(evidence) {
  return evidence.sameProfileAvailable === true && evidence.quotaHeadroom === true && evidence.budgetHeadroom === true && evidence.turnHeadroom === true;
}

/**
 * The exponential-backoff deadline a bounded retry schedule is derived
 * from — shared by ordinary terminal-outcome retries (`retry()` below) and
 * transition-mutation retries (#698 round 5, finding 2), so both use the
 * exact same policy-derived formula rather than two independently
 * maintained backoff calculations.
 */
export function backoffDeadline(attempts, nowMs, policy = DEFAULT_RECOVERY_POLICY) {
  const delay = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * (2 ** Math.max(0, attempts)));
  return new Date(nowMs + delay).toISOString();
}

function retry(reason, action, attempts, cap, nowMs, policy, nextAction) {
  if (attempts >= cap) return { ...forbidden(reason, 'Review the exhausted recovery and provide a new manager decision.'), status: 'exhausted' };
  return { policyRevision: policy.revision, eligible: true, action, status: 'eligible', reason, recoveryAttemptCount: attempts + 1, retryAt: backoffDeadline(attempts, nowMs, policy), nextAction };
}

export function decideRecovery(input, policyOverrides = {}) {
  const policy = { ...DEFAULT_RECOVERY_POLICY, ...policyOverrides };
  const reason = normalizeTerminalOutcome(input.outcome);
  const attempts = Number.isInteger(input.recoveryAttemptCount) ? input.recoveryAttemptCount : 0;
  const evidence = input.evidence || {};
  const nowMs = Date.parse(input.now || new Date().toISOString());
  if (reason === 'completed') return { policyRevision: policy.revision, eligible: false, action: 'none', status: 'not_needed', reason, nextAction: 'No action required.' };
  if (reason === 'plan_only_awaiting_approval') return forbidden(reason, 'Review the plan and explicitly approve or reject implementation.');
  if (reason === 'quota_paused') {
    if (!input.retryAt) return forbidden(reason, 'Wait for a known quota reset, then run a fresh quota preflight.');
    return { policyRevision: policy.revision, eligible: true, action: 'retry_after_quota_preflight', status: 'waiting', reason, recoveryAttemptCount: attempts, retryAt: input.retryAt, nextAction: 'Wait for quota reset and require a fresh quota preflight.' };
  }
  if (!ownershipProven(evidence)) return forbidden(reason, 'Resolve ambiguous process, claim, or lease ownership before recovery.');
  if (reason === 'rate_limited') return retry(reason, 'fresh_retry', attempts, policy.rateLimitAttemptCap, nowMs, policy, 'Retry after bounded provider backoff and a fresh quota preflight.');
  if (reason === 'transient_provider_or_network_failure') {
    if (evidence.repositoryMutated !== false) return forbidden(reason, 'Inspect preserved repository state; do not blind-retry after possible mutation.');
    return retry(reason, 'fresh_retry', attempts, policy.transientAttemptCap, nowMs, policy, 'Retry after bounded backoff only if ownership and headroom remain proven.');
  }
  if (reason === 'turn_limit_exhausted') {
    if (!(evidence.checkpointAvailable === true && evidence.sessionAvailable === true && evidence.profileCompatible === true && headroomProven(evidence)
      && evidence.conflictingWorktree === false && evidence.conflictingBranch === false && evidence.conflictingPr === false)) {
      return forbidden(reason, 'Review the attempt; a proven compatible native checkpoint and exclusive ownership are required to resume.');
    }
    return retry(reason, 'native_resume', attempts, policy.resumeAttemptCap, nowMs, policy, 'Resume the proven native session once with the same qualified profile.');
  }
  if (reason === 'validation_failed') {
    if (!(evidence.explicitDeterministicValidationFailure === true && evidence.policyApproved === true && evidence.checkpointAvailable === true
      && evidence.profileCompatible === true && evidence.worktreeAvailable === true && headroomProven(evidence))) {
      return forbidden(reason, 'Review validation evidence and preserved work before authorizing continuation.');
    }
    return retry(reason, 'same_agent_continuation', attempts, policy.validationAttemptCap, nowMs, policy, 'Continue once in the preserved compatible worktree and checkpoint.');
  }
  return forbidden(reason, 'Inspect the sanitized failure evidence and provide an explicit manager decision.');
}

export function attentionDedupeKey({ repository, issueNumber, attemptId, reason, policyRevision = RECOVERY_POLICY_REVISION }) {
  return createHash('sha256').update([repository, issueNumber, attemptId, normalizeTerminalOutcome(reason), policyRevision].join(':')).digest('hex');
}

export function buildAttentionEvent(input) {
  const reason = normalizeTerminalOutcome(input.reason);
  const allowed = {
    repository: String(input.repository || ''), project: String(input.project || ''), issueNumber: Number(input.issueNumber),
    reason, attemptId: String(input.attemptId || ''), agent: String(input.agent || ''), startedAt: input.startedAt || null,
    finishedAt: input.finishedAt || null, recoveryStatus: input.recoveryStatus || 'forbidden', nextAction: String(input.nextAction || ''),
    dashboardReference: String(input.dashboardReference || ''), policyRevision: input.policyRevision || RECOVERY_POLICY_REVISION,
  };
  return Object.freeze({ ...allowed, dedupeKey: input.dedupeKey || attentionDedupeKey({ repository: allowed.repository, issueNumber: allowed.issueNumber, attemptId: allowed.attemptId, reason, policyRevision: allowed.policyRevision }) });
}

export const RECOVERY_ACTIONS = Object.freeze([
  'fresh_retry',
  'retry_after_quota_preflight',
  'native_resume',
  'same_agent_continuation',
]);

const BASE_REVALIDATION_KEYS = Object.freeze([
  'issueOpen',
  'expectedStatusCurrent',
  'agentOwnershipCurrent',
  'claimRevisionCurrent',
  'preflightRevisionCurrent',
  'authorizationFresh',
  'authorizationCurrent',
  'noConflictingPr',
  'noConflictingBranch',
  'noConflictingWorktree',
  'noHandoff',
  'noConflictingProcess',
  'noConflictingLease',
  'agentCompatible',
  'modelCompatible',
  'harnessCompatible',
]);

const TRANSITION_REVALIDATION_KEYS = Object.freeze([
  ...BASE_REVALIDATION_KEYS,
  'sameRecoveryClaim',
  'sameRecoveryAgent',
  'noNewerManagerAction',
]);

// `transition_reconcile` revalidates a *completed* attempt whose successful
// GitHub transition never durably finished (crash between mutation and
// completion). It cannot reuse `pre_claim`'s `authorizationFresh` key: that
// check requires the authorization to have been created *after* the
// attempt's own `finished_at`, which is backwards here — the authorization
// that permitted this attempt necessarily predates its own completion, so
// the check would fail closed on every real (non-mocked) reconciliation
// pass. `authorizationCurrent` (ID-exact match against the recorded
// authorization, already required by BASE_REVALIDATION_KEYS) is the correct
// and sufficient freshness proof for a completed attempt (#698 finding 2).
// It also cannot reuse `pre_transition`'s TRANSITION_REVALIDATION_KEYS,
// whose `sameRecoveryClaim`/`noNewerManagerAction` keys assume a live
// in-process handoff/lease that cannot hold after a crash and restart.
const TRANSITION_RECONCILE_REVALIDATION_KEYS = Object.freeze(
  BASE_REVALIDATION_KEYS.filter((key) => key !== 'authorizationFresh'),
);

/**
 * Convert collected facts into a fail-closed, persistable decision.  The
 * collector is deliberately separate: absent facts remain absent/false and
 * cannot silently become positive ownership evidence here.
 */
export function evaluateRecoveryRevalidation({ stage, action, evidence = {}, checkedAt = new Date().toISOString() } = {}) {
  const required = stage === 'pre_transition' ? TRANSITION_REVALIDATION_KEYS
    : stage === 'transition_reconcile' ? TRANSITION_RECONCILE_REVALIDATION_KEYS
      : BASE_REVALIDATION_KEYS;
  const actual = Object.fromEntries(required.map((key) => [key, evidence[key] === true]));
  if (action === 'retry_after_quota_preflight') {
    actual.knownQuotaResetReached = evidence.knownQuotaResetReached === true;
    actual.freshQuotaPreflightPassed = evidence.freshQuotaPreflightPassed === true;
  }
  if (action === 'native_resume') {
    actual.restrictedResumeHandleAvailable = evidence.restrictedResumeHandleAvailable === true;
    actual.resumeCliSupportVerified = evidence.resumeCliSupportVerified === true;
    // "current checkpoint evidence" is a required native_resume fact (see
    // docs/ops/AGENT-RUNNER-KIT.md), not only a same_agent_continuation one
    // — dispatchRecoveryAction() also requires it for native_resume, so
    // revalidation must fail closed on a stale/missing checkpoint the same
    // way it already does for continuation (#698 finding 2).
    actual.checkpointCurrent = evidence.checkpointCurrent === true;
    // The restricted handle's cryptographic binding to this exact attempt's
    // persisted identity must independently verify, not merely "a same-
    // attemptId handle file exists" (#698 finding 8).
    actual.restrictedHandleBindingVerified = evidence.restrictedHandleBindingVerified === true;
  }
  if (action === 'same_agent_continuation') {
    actual.preservedWorktreeCurrent = evidence.preservedWorktreeCurrent === true;
    actual.checkpointCurrent = evidence.checkpointCurrent === true;
    actual.explicitContinuationPolicyApproval = evidence.explicitContinuationPolicyApproval === true;
    actual.restrictedHandleBindingVerified = evidence.restrictedHandleBindingVerified === true;
  }
  const actionAllowlisted = RECOVERY_ACTIONS.includes(action);
  const failedChecks = Object.entries(actual).filter(([, value]) => value !== true).map(([key]) => key);
  if (!actionAllowlisted) failedChecks.unshift('actionAllowlisted');
  return Object.freeze({
    stage,
    action: action || null,
    checkedAt,
    allowed: actionAllowlisted && failedChecks.length === 0,
    failedChecks,
    evidence: Object.freeze({ actionAllowlisted, ...actual }),
  });
}

/**
 * The only boundary allowed to turn a persisted recovery action into a child
 * invocation.  Resume/continuation controls are supplied by verified local
 * adapters; this function never invents provider CLI flags.
 */
export function dispatchRecoveryAction({ action, revalidation, ordinaryInvocation, quota = {}, nativeResume = {}, continuation = {} } = {}) {
  const denied = (reason) => Object.freeze({ allowed: false, action: action || null, reason, invocation: null });
  if (!RECOVERY_ACTIONS.includes(action)) return denied('unsupported-recovery-action');
  if (revalidation?.allowed !== true) return denied('recovery-revalidation-failed');

  if (action === 'fresh_retry') {
    if (!ordinaryInvocation?.command || !Array.isArray(ordinaryInvocation.args)) return denied('ordinary-invocation-unavailable');
    return Object.freeze({ allowed: true, action, reason: null, invocation: { ...ordinaryInvocation, args: [...ordinaryInvocation.args] } });
  }
  if (action === 'retry_after_quota_preflight') {
    if (!ordinaryInvocation?.command || !Array.isArray(ordinaryInvocation.args)) return denied('ordinary-invocation-unavailable');
    if (!(quota.knownResetReached === true && quota.freshPreflightPassed === true && quota.managerAuthorizationCurrent === true)) {
      return denied('quota-recovery-evidence-incomplete');
    }
    return Object.freeze({ allowed: true, action, reason: null, invocation: { ...ordinaryInvocation, args: [...ordinaryInvocation.args] } });
  }
  if (action === 'native_resume') {
    // #698 round 5, finding 4: fail closed for this release regardless of
    // CLI capability. The installed Claude CLI is below the documented
    // resume-capability minimum and no supervised positive production run
    // exists, so an explicit machine-local enablement gate (separate from
    // "the CLI happens to report support") must also be open before this
    // action may ever launch anything. Checked first so a denial here
    // surfaces the exact, unambiguous reason rather than being folded into
    // the generic evidence-incomplete check below.
    if (nativeResume.enablementGateOpen !== true) return denied('native-resume-disabled-for-this-release');
    if (!(nativeResume.restrictedHandle && nativeResume.checkpointCurrent === true && nativeResume.cliSupportVerified === true)) {
      return denied('native-resume-evidence-incomplete');
    }
    if (!nativeResume.invocation?.command || !Array.isArray(nativeResume.invocation.args)) {
      return denied('native-resume-invocation-unavailable');
    }
    return Object.freeze({ allowed: true, action, reason: null, invocation: { ...nativeResume.invocation, args: [...nativeResume.invocation.args] } });
  }
  // Same-release fail-closed gate as native_resume above (#698 round 5,
  // finding 4) — same_agent_continuation is the other restricted-recovery
  // action this release disables by default.
  if (continuation.enablementGateOpen !== true) return denied('same-agent-continuation-disabled-for-this-release');
  if (!(continuation.preservedWorktreeCurrent === true && continuation.checkpointCurrent === true
    && continuation.policyApproved === true && continuation.invocation?.command && Array.isArray(continuation.invocation.args))) {
    return denied('same-agent-continuation-evidence-incomplete');
  }
  return Object.freeze({ allowed: true, action, reason: null, invocation: { ...continuation.invocation, args: [...continuation.invocation.args] } });
}

/**
 * Dead-process-only orphan detection. As of #698 round 5, no production
 * code path calls this anymore — `reconcileSchedulerAttempts()` in
 * claude-runner-cron.mjs replaced it with a single authoritative check
 * (`computeAttemptLivenessEvidence()`/`classifyAttemptLivenessState()`)
 * that also demotes a live process whose lease, manager authority, or
 * progress is no longer current, which this function alone could never
 * detect (a live process here always "passed"). Retained as a standalone,
 * still-correct, still-tested pure function rather than removed outright,
 * since deleting it would also require deleting its dedicated unit tests
 * for no behavioral gain this round.
 */
export async function reconcileActiveAttempts(attempts, { isProcessLive, now = () => new Date().toISOString() }) {
  const reconciled = [];
  for (const attempt of attempts) {
    if (attempt.finishedAt || attempt.outcome || attempt.resolutionState === 'resolved') continue;
    let live;
    try {
      live = await isProcessLive({
        claimId: attempt.claimId,
        attemptId: attempt.attemptId,
        issueNumber: attempt.issueNumber,
        processId: attempt.processId,
        processBootId: attempt.processBootId,
        processStartTicks: attempt.processStartTicks,
        systemdInvocationId: attempt.systemdInvocationId,
      });
    } catch {
      live = null;
    }
    if (live === true) continue;
    reconciled.push({ ...attempt, finishedAt: now(), outcome: live === false ? 'orphaned_active_claim' : 'unknown_failure', recoveryEligible: false, recoveryAction: 'attention_required', attentionStatus: 'attention_required', resolutionState: 'unresolved' });
  }
  return reconciled;
}
