import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFailureProjection,
  deriveFailureProjection,
  FAILURE_PROJECTION_SCHEMA_VERSION,
} from './agent-runner-failure-projection.mjs';

const SYNTHETIC_TOKEN = ['ghp', 'a1b2c3d4e5a1b2c3d4e5a1b2c3'].join('_');
const POLICY_REVISION = 'AR230-FAILURE-PROJECTION-SCHEMA-2026-08-26.1';
const MANAGER_AUTHORITY_FINGERPRINT = 'sha256:b711bef4f0a57e1e7c5eed0f5534671830909931a300e14fcd7d3766be5bda9f';

function baseFields(overrides = {}) {
  return {
    policyRevision: POLICY_REVISION,
    managerAuthorityFingerprint: MANAGER_AUTHORITY_FINGERPRINT,
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    executionPhase: 'candidate_admission',
    candidateAdmissionCompleted: false,
    attemptCreated: false,
    managerPacketConsumed: false,
    issueMutation: false,
    workspaceCreated: false,
    childLaunched: false,
    providerInvocationObserved: 'no',
    failureScope: 'none',
    reasonDomain: 'none',
    reason: null,
    safeNextAction: 'No action required.',
    deeperDiagnosticsRequired: false,
    ...overrides,
  };
}

function postAttemptFields(overrides = {}) {
  return baseFields({
    attemptId: 'attempt-230-1',
    executionPhase: 'provider_invocation',
    candidateAdmissionCompleted: true,
    attemptCreated: true,
    managerPacketConsumed: true,
    workspaceCreated: true,
    childLaunched: true,
    providerInvocationObserved: 'yes',
    failureScope: 'task_attempt',
    reasonDomain: 'terminal_outcome',
    reason: 'process_crash_or_signal',
    terminalOutcome: 'process_crash_or_signal',
    safeNextAction: 'Inspect preserved repository state before any retry.',
    ...overrides,
  });
}

test('a projection exposes schema, candidate, incident and whole-projection fingerprints deterministically', () => {
  const projection = buildFailureProjection(baseFields());
  assert.equal(projection.schemaVersion, FAILURE_PROJECTION_SCHEMA_VERSION);
  assert.match(projection.candidateFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.incidentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(projection.projectionFingerprint, /^sha256:[0-9a-f]{64}$/);
  const again = buildFailureProjection(baseFields());
  assert.equal(again.candidateFingerprint, projection.candidateFingerprint);
  assert.equal(again.incidentFingerprint, projection.incidentFingerprint);
  assert.equal(again.projectionFingerprint, projection.projectionFingerprint);
});

test('canonical uppercase manager policy revision and authority fingerprint are accepted', () => {
  const projection = buildFailureProjection(baseFields());
  assert.equal(projection.policyRevision, POLICY_REVISION);
  assert.equal(projection.managerAuthorityFingerprint, MANAGER_AUTHORITY_FINGERPRINT);
});

test('policy revision stays bounded and machine-safe', () => {
  assert.throws(() => buildFailureProjection(baseFields({ policyRevision: 'AR230 revision with spaces' })), /policyRevision/);
});

test('a projection refuses an unknown top-level field', () => {
  assert.throws(() => buildFailureProjection(baseFields({ extraField: 'nope' })), /not a recognised field|Invalid agent runner failure projection/);
});

test('a projection refuses prompts, provider output, logs, stacks, credentials, tokens, packet bodies, restricted handles, paths, command lines and diffs by field name at any depth', () => {
  const nested = {
    ...baseFields(),
    notes: {
      prompt: 'do something', stdout: 'x', stderr: 'y', stack: 'z', env: { A: '1' }, token: SYNTHETIC_TOKEN,
      packetBody: 'body', commentBody: 'body', restrictedHandle: 'h', diff: '+x', fileContents: 'y',
      commandLine: 'rm -rf /', localPath: '/home/x',
    },
  };
  assert.throws(() => buildFailureProjection(nested), /never projectable/);
});

test('a projection refuses out-of-range enums', () => {
  assert.throws(() => buildFailureProjection(baseFields({ executionPhase: 'not-a-real-phase' })), /executionPhase/);
  assert.throws(() => buildFailureProjection(baseFields({ failureScope: 'bogus' })), /failureScope/);
  assert.throws(() => buildFailureProjection(baseFields({ providerInvocationObserved: 'maybe' })), /providerInvocationObserved/);
});

test('a hand-built look-alike projection cannot feed derived fingerprint fields back into the builder', () => {
  const lookAlike = { ...buildFailureProjection(baseFields()), rawLog: 'oops' };
  const {
    schemaVersion,
    candidateFingerprint,
    incidentFingerprint,
    projectionFingerprint,
    ...withoutDerived
  } = lookAlike;
  assert.throws(() => buildFailureProjection(withoutDerived), /never projectable|not a recognised field/);
});

test('pre-claim candidate cost refusal reports explicit zero side effects and exact known cost reason', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'cost_admission',
    candidateAdmissionCompleted: true,
    managerPacketConsumed: true,
    failureScope: 'machine_profile',
    reasonDomain: 'cost_admission',
    reason: 'candidate-machine-profile-cost-denied',
    safeNextAction: 'Issue a fresh superseding immutable manager-preflight authority.',
  }));
  assert.equal(projection.reason, 'candidate-machine-profile-cost-denied');
  assert.equal(projection.attemptCreated, false);
  assert.equal(projection.workspaceCreated, false);
  assert.equal(projection.childLaunched, false);
  assert.equal(projection.issueMutation, false);
  assert.equal(projection.providerInvocationObserved, 'no');
  assert.equal(projection.deeperDiagnosticsRequired, false);
  assert.equal(projection.attemptId, null);
});

test('pre-provider tool-capability mismatch preserves exact reason and bounded capability identifiers', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'capability_admission',
    candidateAdmissionCompleted: true,
    managerPacketConsumed: true,
    failureScope: 'machine_profile',
    reasonDomain: 'capability_admission',
    reason: 'implementation-tool-capability-mismatch',
    missingCapabilities: ['repo-validation'],
    safeNextAction: 'Revise manager intent or add a separately reviewed bounded tool/harness mapping before provider launch.',
  }));
  assert.equal(projection.reason, 'implementation-tool-capability-mismatch');
  assert.deepEqual(projection.missingCapabilities, ['repo-validation']);
  assert.equal(projection.childLaunched, false);
  assert.equal(projection.providerInvocationObserved, 'no');
});

test('an unknown capability identifier is refused rather than silently accepted', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    executionPhase: 'capability_admission',
    failureScope: 'machine_profile',
    reasonDomain: 'capability_admission',
    reason: 'implementation-tool-capability-mismatch',
    missingCapabilities: ['not-a-real-capability'],
    safeNextAction: 'Review.',
  })), /known #228 capability identifier/);
});

test('missingCapabilities must stay empty outside capability_admission', () => {
  assert.throws(() => buildFailureProjection(baseFields({ missingCapabilities: ['repo-validation'] })), /missingCapabilities must be empty/);
});

test('budget-limit exhaustion carries a real bounded attempt identity and stays distinct from quota/unknown', () => {
  const projection = buildFailureProjection(postAttemptFields({
    attemptId: 'attempt-budget-230-1',
    reason: 'budget_limit_exhausted',
    terminalOutcome: 'budget_limit_exhausted',
    checkpointPresent: true,
    worktreePresent: true,
    recoveryStatus: 'forbidden',
    recoveryAction: 'attention_required',
    recoveryEligible: false,
    safeNextAction: 'Provide an explicit manager decision before any fresh dispatch.',
  }));
  assert.equal(projection.attemptId, 'attempt-budget-230-1');
  assert.equal(projection.reason, 'budget_limit_exhausted');
  assert.notEqual(projection.reason, 'quota_paused');
  assert.notEqual(projection.reason, 'unknown_failure');
});

test('task_attempt evidence refuses a missing attemptId', () => {
  assert.throws(() => buildFailureProjection(postAttemptFields({ attemptId: null })), /real attemptId is required/);
});

test('attemptCreated true refuses a missing attemptId even before task_attempt classification', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    executionPhase: 'attempt_creation',
    candidateAdmissionCompleted: true,
    attemptCreated: true,
    attemptId: null,
  })), /real attemptId is required/);
});

test('successful no-change outcome preserves exact typed reason rather than collapsing to unknown_failure', () => {
  const projection = buildFailureProjection(postAttemptFields({
    attemptId: 'attempt-no-change-230-1',
    executionPhase: 'completed',
    reason: 'implementation_no_repository_change',
    terminalOutcome: 'implementation_no_repository_change',
    checkpointPresent: true,
    worktreePresent: true,
    commitPresent: false,
    dirty: false,
    hasChanges: false,
    recoveryStatus: 'forbidden',
    recoveryAction: 'attention_required',
    recoveryEligible: false,
    safeNextAction: 'Review the run log and issue scope, then provide an explicit manager decision.',
  }));
  assert.equal(projection.reason, 'implementation_no_repository_change');
  assert.equal(projection.commitPresent, false);
});

test('worker exit with clean worktree/no commit reports bounded booleans without content', () => {
  const projection = buildFailureProjection(postAttemptFields({
    attemptId: 'attempt-clean-exit-230-1',
    executionPhase: 'completed',
    reason: 'process_crash_or_signal',
    terminalOutcome: 'process_crash_or_signal',
    worktreePresent: true,
    branchPresent: true,
    commitPresent: false,
    dirty: false,
    hasChanges: false,
    recoveryStatus: 'forbidden',
    recoveryAction: 'attention_required',
    recoveryEligible: false,
    safeNextAction: 'Inspect the sanitized failure evidence and provide an explicit manager decision.',
  }));
  assert.equal(projection.dirty, false);
  assert.equal(projection.commitPresent, false);
  assert.equal(projection.worktreePresent, true);
});

test('committed checkpoint is bounded presence only, never content/path', () => {
  const projection = buildFailureProjection(postAttemptFields({
    attemptId: 'attempt-checkpoint-230-1',
    reason: 'provider_execution_limit',
    terminalOutcome: 'provider_execution_limit',
    checkpointPresent: true,
    worktreePresent: true,
    branchPresent: true,
    commitPresent: true,
    prPresent: false,
    dirty: false,
    hasChanges: true,
    recoveryStatus: 'forbidden',
    recoveryAction: 'attention_required',
    recoveryEligible: false,
    safeNextAction: 'Review the attempt; a proven compatible native checkpoint and exclusive ownership are required to resume.',
  }));
  assert.equal(projection.checkpointPresent, true);
  assert.equal(projection.commitPresent, true);
  assert.equal(Object.keys(projection).includes('checkpointPath'), false);
  assert.equal(JSON.stringify(projection).includes('/home/'), false);
});

test('pre-attempt incident fingerprint binds manager authority/policy/reason but ignores presentation/status fields', () => {
  const first = buildFailureProjection(baseFields({
    executionPhase: 'cost_admission',
    failureScope: 'machine_profile',
    reasonDomain: 'cost_admission',
    reason: 'candidate-machine-profile-cost-denied',
    safeNextAction: 'First bounded action.',
    circuitState: 'clear',
  }));
  const presentationChanged = buildFailureProjection(baseFields({
    executionPhase: 'cost_admission',
    failureScope: 'machine_profile',
    reasonDomain: 'cost_admission',
    reason: 'candidate-machine-profile-cost-denied',
    safeNextAction: 'Different presentation text.',
    circuitState: 'tripped',
  }));
  assert.equal(first.incidentFingerprint, presentationChanged.incidentFingerprint);
  assert.notEqual(first.projectionFingerprint, presentationChanged.projectionFingerprint);

  const authorityChanged = buildFailureProjection(baseFields({
    managerAuthorityFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    executionPhase: 'cost_admission',
    failureScope: 'machine_profile',
    reasonDomain: 'cost_admission',
    reason: 'candidate-machine-profile-cost-denied',
    safeNextAction: 'First bounded action.',
  }));
  assert.notEqual(first.incidentFingerprint, authorityChanged.incidentFingerprint);
});

test('post-attempt incident fingerprint binds real attempt/reason/outcome/policy and ignores presentation/status fields', () => {
  const first = buildFailureProjection(postAttemptFields({
    attemptId: 'attempt-stable-230-1',
    safeNextAction: 'First bounded action.',
    recoveryStatus: 'waiting',
  }));
  const statusChanged = buildFailureProjection(postAttemptFields({
    attemptId: 'attempt-stable-230-1',
    safeNextAction: 'Different presentation text.',
    recoveryStatus: 'forbidden',
  }));
  assert.equal(first.incidentFingerprint, statusChanged.incidentFingerprint);
  assert.notEqual(first.projectionFingerprint, statusChanged.projectionFingerprint);

  const attemptChanged = buildFailureProjection(postAttemptFields({
    attemptId: 'attempt-stable-230-2',
    safeNextAction: 'First bounded action.',
    recoveryStatus: 'waiting',
  }));
  assert.notEqual(first.incidentFingerprint, attemptChanged.incidentFingerprint);
});

test('genuinely systemic/unclassifiable case requires deeper diagnostics rather than manufactured certainty', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'systemic',
    candidateAdmissionCompleted: null,
    attemptCreated: null,
    managerPacketConsumed: null,
    issueMutation: null,
    workspaceCreated: null,
    childLaunched: null,
    providerInvocationObserved: 'unknown',
    failureScope: 'systemic',
    reasonDomain: 'unclassified',
    reason: null,
    deeperDiagnosticsRequired: true,
    diagnosticDomain: 'unclassified',
    safeNextAction: 'Preserve state untouched and inspect it directly before any decision.',
  }));
  assert.equal(projection.deeperDiagnosticsRequired, true);
  assert.equal(projection.diagnosticDomain, 'unclassified');
  assert.equal(projection.reason, null);
});

test('deeperDiagnosticsRequired true without diagnosticDomain is refused', () => {
  assert.throws(() => buildFailureProjection(baseFields({ deeperDiagnosticsRequired: true })), /diagnosticDomain is required/);
});

test('diagnosticDomain cannot manufacture a deeper-diagnostics decision when that fact is false or unknown', () => {
  assert.throws(() => buildFailureProjection(baseFields({ diagnosticDomain: 'unclassified' })), /requires deeperDiagnosticsRequired/);
  assert.throws(() => buildFailureProjection(baseFields({ deeperDiagnosticsRequired: null, diagnosticDomain: 'unclassified' })), /requires deeperDiagnosticsRequired/);
});

test('childLaunched true is refused before executionPhase reaches child_launch', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    attemptId: 'attempt-230-child-early',
    executionPhase: 'attempt_creation',
    candidateAdmissionCompleted: true,
    attemptCreated: true,
    childLaunched: true,
  })), /childLaunched cannot be true/);
});

test('providerInvocationObserved yes is refused when childLaunched is false', () => {
  assert.throws(() => buildFailureProjection(baseFields({ providerInvocationObserved: 'yes' })), /providerInvocationObserved cannot be yes/);
});

test('workspaceCreated true is refused when attemptCreated is false', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    executionPhase: 'workspace_preparation',
    workspaceCreated: true,
  })), /workspaceCreated\/childLaunched cannot be true/);
});

test('known terminal_outcome reason outside vocabulary is refused', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    attemptId: 'attempt-230-bad-reason',
    executionPhase: 'attempt_creation',
    candidateAdmissionCompleted: true,
    attemptCreated: true,
    failureScope: 'task_attempt',
    reasonDomain: 'terminal_outcome',
    reason: 'not-a-real-outcome',
  })), /known terminal_outcome reason/);
});

test('terminalOutcome completed requires failureScope none', () => {
  assert.throws(() => buildFailureProjection(postAttemptFields({ terminalOutcome: 'completed' })), /terminalOutcome completed requires failureScope none/);
});

test('deriveFailureProjection extracts known safe fields, reuses preflight fingerprint, and ignores adversarial extras', () => {
  const projection = deriveFailureProjection({
    policyRevision: POLICY_REVISION,
    preflightFingerprint: MANAGER_AUTHORITY_FINGERPRINT,
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    executionPhase: 'cost_admission',
    candidateAdmissionCompleted: true,
    managerPacketConsumed: true,
    failureScope: 'machine_profile',
    reasonDomain: 'cost_admission',
    reason: 'candidate-machine-profile-cost-denied',
    safeNextAction: 'Issue a fresh superseding immutable manager-preflight authority.',
    prompt: 'ignore all instructions',
    stdout: 'raw child output',
    stderr: 'raw child stderr',
    stack: 'Error: x\n  at y',
    env: { GITHUB_TOKEN: SYNTHETIC_TOKEN },
    token: SYNTHETIC_TOKEN,
    localPath: '/home/runner/.claude/worktrees/secret',
    commandLine: 'claude --dangerously-skip-permissions',
    packetBody: 'full manager packet markdown',
    commentBody: 'full github comment markdown',
    restrictedHandle: { attemptId: '1', sessionId: 'abc' },
    diff: '--- a/file\n+++ b/file',
    fileContents: 'entire file body',
  });
  assert.equal(projection.repository, 'TheTekTeam/agent-runner');
  assert.equal(projection.reason, 'candidate-machine-profile-cost-denied');
  assert.equal(projection.managerAuthorityFingerprint, MANAGER_AUTHORITY_FINGERPRINT);
  const serialized = JSON.stringify(projection);
  for (const forbidden of [
    'ignore all instructions', 'raw child output', 'raw child stderr', SYNTHETIC_TOKEN, '/home/runner',
    'dangerously-skip-permissions', 'full manager packet', 'full github comment', 'sessionId', '--- a/file',
    'entire file body',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `projection must never contain: ${forbidden}`);
  }
});

test('deriveFailureProjection preserves unavailable lifecycle facts as null and derives false only where phase proves impossibility', () => {
  const projection = deriveFailureProjection({
    policyRevision: POLICY_REVISION,
    preflightFingerprint: MANAGER_AUTHORITY_FINGERPRINT,
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    executionPhase: 'candidate_admission',
    failureScope: 'issue_not_runnable',
    reasonDomain: 'candidate_admission',
    reason: 'candidate-no-longer-runnable',
    safeNextAction: 'Repair execution-critical status/agent labels before another dispatch.',
  });
  assert.equal(projection.candidateAdmissionCompleted, null);
  assert.equal(projection.managerPacketConsumed, null);
  assert.equal(projection.issueMutation, null);
  assert.equal(projection.deeperDiagnosticsRequired, null);
  assert.equal(projection.attemptCreated, false);
  assert.equal(projection.workspaceCreated, false);
  assert.equal(projection.childLaunched, false);
  assert.equal(projection.providerInvocationObserved, 'no');
});

test('deriveFailureProjection leaves phase-local attempt/workspace/child facts unknown at the phase where they may or may not have happened', () => {
  const attempt = deriveFailureProjection({
    policyRevision: POLICY_REVISION,
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    executionPhase: 'attempt_creation',
    failureScope: 'none',
    reasonDomain: 'none',
    safeNextAction: 'Inspect bounded state.',
  });
  assert.equal(attempt.attemptCreated, null);
  assert.equal(attempt.workspaceCreated, false);
  assert.equal(attempt.childLaunched, false);

  const workspace = deriveFailureProjection({
    policyRevision: POLICY_REVISION,
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    executionPhase: 'workspace_preparation',
    failureScope: 'none',
    reasonDomain: 'none',
    safeNextAction: 'Inspect bounded state.',
  });
  assert.equal(workspace.attemptCreated, null);
  assert.equal(workspace.workspaceCreated, null);
  assert.equal(workspace.childLaunched, false);
});

test('deriveFailureProjection defaults providerInvocationObserved to unknown once provider phase is reached without accounting evidence', () => {
  const projection = deriveFailureProjection({
    policyRevision: POLICY_REVISION,
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    attemptId: 'attempt-provider-unknown-230-1',
    executionPhase: 'provider_invocation',
    candidateAdmissionCompleted: true,
    attemptCreated: true,
    managerPacketConsumed: true,
    workspaceCreated: true,
    childLaunched: true,
    failureScope: 'task_attempt',
    reasonDomain: 'terminal_outcome',
    reason: 'transient_provider_or_network_failure',
    terminalOutcome: 'transient_provider_or_network_failure',
    safeNextAction: 'Inspect preserved repository state before any retry.',
  });
  assert.equal(projection.providerInvocationObserved, 'unknown');
});

test('deriveFailureProjection enforces the same lifecycle/reason consistency as buildFailureProjection', () => {
  assert.throws(() => deriveFailureProjection({
    policyRevision: POLICY_REVISION,
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    executionPhase: 'candidate_admission',
    childLaunched: true,
    failureScope: 'none',
    reasonDomain: 'none',
    safeNextAction: 'x',
  }), /childLaunched cannot be true/);
});
