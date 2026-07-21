import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttentionEvent,
  decideRecovery,
  dispatchRecoveryAction,
  evaluateRecoveryRevalidation,
  normalizeTerminalOutcome,
  reconcileActiveAttempts,
} from './claude-runner-recovery.mjs';

const exclusive = { processOwner: false, conflictingLease: false, ownershipAmbiguous: false };
const headroom = { sameProfileAvailable: true, quotaHeadroom: true, budgetHeadroom: true, continuationHeadroom: true };

test('normalizes legacy max-turn outcome and refuses resume without checkpoint', () => {
  assert.equal(normalizeTerminalOutcome('provider-execution-limit'), 'provider_execution_limit');
  assert.equal(decideRecovery({ outcome: 'provider-execution-limit', evidence: exclusive }).eligible, false);
});

test('normalizes both Claude plan approval spellings to the canonical approval wait', () => {
  assert.equal(normalizeTerminalOutcome('awaiting-plan-approval'), 'plan_only_awaiting_approval');
  assert.equal(normalizeTerminalOutcome('awaiting_plan_approval'), 'plan_only_awaiting_approval');
  const decision = decideRecovery({ outcome: 'awaiting-plan-approval', evidence: exclusive });
  assert.equal(decision.reason, 'plan_only_awaiting_approval');
  assert.equal(decision.status, 'forbidden');
  assert.match(decision.nextAction, /explicitly approve or reject/i);
});

test('native turn-limit resume is capped at one and fails closed on ownership ambiguity', () => {
  const evidence = { ...exclusive, ...headroom, checkpointAvailable: true, sessionAvailable: true, profileCompatible: true, conflictingWorktree: false, conflictingBranch: false, conflictingPr: false };
  assert.equal(decideRecovery({ outcome: 'provider_execution_limit', recoveryAttemptCount: 0, now: '2026-01-01T00:00:00Z', evidence }).action, 'native_resume');
  assert.equal(decideRecovery({ outcome: 'provider_execution_limit', recoveryAttemptCount: 1, evidence }).status, 'exhausted');
  assert.equal(decideRecovery({ outcome: 'provider_execution_limit', evidence: { ...evidence, ownershipAmbiguous: true } }).eligible, false);
});

test('transient recovery is bounded and forbidden after mutation', () => {
  const before = decideRecovery({ outcome: 'transient_provider_or_network_failure', now: '2026-01-01T00:00:00Z', evidence: { ...exclusive, repositoryMutated: false } });
  assert.equal(before.action, 'fresh_retry'); assert.equal(before.recoveryAttemptCount, 1); assert.equal(before.retryAt, '2026-01-01T00:01:00.000Z');
  assert.equal(decideRecovery({ outcome: 'transient_provider_or_network_failure', evidence: { ...exclusive, repositoryMutated: true } }).eligible, false);
});

test('plan, auth, crash, and unknown failures require attention without retry', () => {
  for (const outcome of ['plan_only_awaiting_approval', 'permission_or_auth_failure', 'process_crash_or_signal', 'unknown_failure']) assert.equal(decideRecovery({ outcome, evidence: exclusive }).action, 'attention_required');
});

test('decideRecovery never returns eligible:true without a truthy retryAt, across every reachable branch (#698 round 5 next_retry_at scheduling invariant)', () => {
  // The scheduler now treats a persisted `next_retry_at IS NULL` row as due
  // immediately (dueRecoveryAttempts()/claimRecovery() in
  // claude-runner-state.mjs). Every production write site derives
  // `nextRetryAt` from `decision.retryAt` gated by `decision.eligible`
  // (claude-runner-cron.mjs), so this is the single choke point that
  // guarantees an eligible row is never silently scheduled as "due now"
  // instead of its real bounded deadline.
  const cases = [
    { outcome: 'quota_paused', retryAt: '2026-01-01T00:05:00Z', evidence: exclusive },
    { outcome: 'rate_limited', evidence: exclusive },
    { outcome: 'transient_provider_or_network_failure', evidence: { ...exclusive, repositoryMutated: false } },
    { outcome: 'provider_execution_limit', evidence: { ...exclusive, ...headroom, checkpointAvailable: true, sessionAvailable: true, profileCompatible: true, conflictingWorktree: false, conflictingBranch: false, conflictingPr: false } },
    { outcome: 'validation_failed', evidence: { ...exclusive, explicitDeterministicValidationFailure: true, policyApproved: true, checkpointAvailable: true, profileCompatible: true, worktreeAvailable: true, ...headroom } },
  ];
  let eligibleCasesSeen = 0;
  for (const input of cases) {
    const decision = decideRecovery({ ...input, now: '2026-01-01T00:00:00Z' });
    if (decision.eligible) {
      eligibleCasesSeen += 1;
      assert.ok(decision.retryAt, `outcome ${input.outcome}: eligible:true must carry a truthy retryAt, got ${decision.retryAt}`);
    }
  }
  assert.equal(eligibleCasesSeen, cases.length, 'every constructed case must actually reach eligible:true to exercise the invariant');
});

test('validation continuation requires deterministic preserved compatible evidence', () => {
  const evidence = { ...exclusive, ...headroom, explicitDeterministicValidationFailure: true, policyApproved: true, checkpointAvailable: true, profileCompatible: true, worktreeAvailable: true };
  assert.equal(decideRecovery({ outcome: 'validation_failed', evidence }).action, 'same_agent_continuation');
  assert.equal(decideRecovery({ outcome: 'validation_failed', evidence: { ...evidence, checkpointAvailable: false } }).eligible, false);
});

test('attention payload is allowlisted and excludes restricted diagnostics', () => {
  const event = buildAttentionEvent({ repository: 'o/r', project: 'p', issueNumber: 698, reason: 'unknown_failure', attemptId: 'a', agent: 'claude', prompt: 'secret', stdout: '/home/secret token', checkpointHandle: 'raw' });
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /secret|stdout|checkpointHandle|\/home/); assert.match(event.dedupeKey, /^[a-f0-9]{64}$/);
});

const safeRevalidationEvidence = Object.freeze({
  issueOpen: true, expectedStatusCurrent: true, agentOwnershipCurrent: true, claimRevisionCurrent: true, preflightRevisionCurrent: true,
  authorizationFresh: true, authorizationCurrent: true, noConflictingPr: true, noConflictingBranch: true,
  noConflictingWorktree: true, noHandoff: true, noConflictingProcess: true, noConflictingLease: true,
  agentCompatible: true, modelCompatible: true, harnessCompatible: true,
});

test('recovery revalidation persists actual false/missing facts and fails closed', () => {
  const result = evaluateRecoveryRevalidation({ stage: 'pre_launch', action: 'fresh_retry', evidence: { ...safeRevalidationEvidence, claimRevisionCurrent: false } });
  assert.equal(result.allowed, false);
  assert.equal(result.evidence.claimRevisionCurrent, false);
  assert.deepEqual(result.failedChecks, ['claimRevisionCurrent']);
  const missing = evaluateRecoveryRevalidation({ stage: 'pre_launch', action: 'fresh_retry', evidence: {} });
  assert.equal(missing.allowed, false);
  assert.equal(Object.values(missing.evidence).some((value) => value === false), true);
});

test('recovery action dispatcher is exhaustive and does not turn incomplete actions into a fresh run', () => {
  const revalidation = evaluateRecoveryRevalidation({ stage: 'pre_launch', action: 'fresh_retry', evidence: safeRevalidationEvidence });
  const ordinaryInvocation = { command: 'node', args: ['runner.mjs', '--issue', '698'] };
  assert.equal(dispatchRecoveryAction({ action: 'fresh_retry', revalidation, ordinaryInvocation }).allowed, true);
  assert.equal(dispatchRecoveryAction({ action: 'unknown', revalidation, ordinaryInvocation }).allowed, false);
  // #698 round 5, finding 4: with no enablement gate open at all (the
  // default, undefined `nativeResume`/`continuation` shape), both
  // restricted actions must deny with the release-disabled reason, not
  // fall through to the generic evidence-incomplete reason.
  assert.equal(dispatchRecoveryAction({ action: 'native_resume', revalidation: { allowed: true }, ordinaryInvocation }).reason, 'native-resume-disabled-for-this-release');
  assert.equal(dispatchRecoveryAction({ action: 'same_agent_continuation', revalidation: { allowed: true }, ordinaryInvocation }).reason, 'same-agent-continuation-disabled-for-this-release');
  // With the gate open but other evidence missing, the specific
  // evidence-incomplete reason still applies underneath the gate check.
  assert.equal(dispatchRecoveryAction({ action: 'native_resume', revalidation: { allowed: true }, ordinaryInvocation, nativeResume: { enablementGateOpen: true } }).reason, 'native-resume-evidence-incomplete');
  assert.equal(dispatchRecoveryAction({ action: 'same_agent_continuation', revalidation: { allowed: true }, ordinaryInvocation, continuation: { enablementGateOpen: true } }).reason, 'same-agent-continuation-evidence-incomplete');
  const native = dispatchRecoveryAction({
    action: 'native_resume', revalidation: { allowed: true },
    nativeResume: { restrictedHandle: 'local-secret-reference', checkpointCurrent: true, cliSupportVerified: true, enablementGateOpen: true, invocation: { command: 'verified-adapter', args: ['internal-native-resume'] } },
  });
  assert.deepEqual(native.invocation, { command: 'verified-adapter', args: ['internal-native-resume'] });
});

test('quota recovery requires the known reset, a fresh quota check, and current manager authorization', () => {
  const revalidation = evaluateRecoveryRevalidation({
    stage: 'pre_launch', action: 'retry_after_quota_preflight',
    evidence: { ...safeRevalidationEvidence, knownQuotaResetReached: true, freshQuotaPreflightPassed: true },
  });
  const ordinaryInvocation = { command: 'node', args: ['runner.mjs'] };
  assert.equal(dispatchRecoveryAction({ action: 'retry_after_quota_preflight', revalidation, ordinaryInvocation, quota: { knownResetReached: true, freshPreflightPassed: true, managerAuthorizationCurrent: true } }).allowed, true);
  assert.equal(dispatchRecoveryAction({ action: 'retry_after_quota_preflight', revalidation, ordinaryInvocation, quota: { knownResetReached: true, freshPreflightPassed: false, managerAuthorizationCurrent: true } }).allowed, false);
});

test('watchdog classifies a missing process as an orphan within one injectable probe pass', async () => {
  const rows = await reconcileActiveAttempts([{ attemptId: 'a', claimId: 'c', issueNumber: 698, startedAt: '2026-01-01T00:00:00Z' }], { isProcessLive: async () => false, now: () => '2026-01-01T00:02:00Z' });
  assert.equal(rows[0].outcome, 'orphaned_active_claim'); assert.equal(rows[0].attentionStatus, 'attention_required');
});

test('watchdog probe ambiguity fails closed as attention, not a live claim', async () => {
  const rows = await reconcileActiveAttempts([{ attemptId: 'a', issueNumber: 698, startedAt: '2026-01-01T00:00:00Z' }], { isProcessLive: async () => { throw new Error('ambiguous'); } });
  assert.equal(rows[0].outcome, 'unknown_failure');
  assert.equal(rows[0].attentionStatus, 'attention_required');
});
