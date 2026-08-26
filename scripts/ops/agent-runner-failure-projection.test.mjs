import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFailureProjection,
  deriveFailureProjection,
  FAILURE_PROJECTION_SCHEMA_VERSION,
} from './agent-runner-failure-projection.mjs';

// Assembled at runtime so the adversarial fixture never appears as a literal
// credential in the checked-in source.
const SYNTHETIC_TOKEN = ['ghp', 'a1b2c3d4e5a1b2c3d4e5a1b2c3'].join('_');

function baseFields(overrides = {}) {
  return {
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

test('a projection exposes the schema version and a deterministic fingerprint', () => {
  const projection = buildFailureProjection(baseFields());
  assert.equal(projection.schemaVersion, FAILURE_PROJECTION_SCHEMA_VERSION);
  assert.match(projection.projectionFingerprint, /^sha256:[0-9a-f]{64}$/);
  const again = buildFailureProjection(baseFields());
  assert.equal(again.projectionFingerprint, projection.projectionFingerprint);
});

test('a projection refuses an unknown top-level field', () => {
  assert.throws(() => buildFailureProjection(baseFields({ extraField: 'nope' })), /not a recognised field|Invalid agent runner failure projection/);
});

test('a projection refuses prompts, provider output, logs, stacks, credentials, tokens, packet bodies, restricted handles, paths, command lines and diffs by field name at any depth', () => {
  const adversarial = baseFields({
    policyRevision: undefined,
  });
  const nested = { ...adversarial, notes: { prompt: 'do something', stdout: 'x', stderr: 'y', stack: 'z', env: { A: '1' }, token: SYNTHETIC_TOKEN, packetBody: 'body', commentBody: 'body', restrictedHandle: 'h', diff: '+x', fileContents: 'y', commandLine: 'rm -rf /', localPath: '/home/x' } };
  assert.throws(() => buildFailureProjection(nested), /never projectable/);
});

test('a projection refuses an out-of-range enum value', () => {
  assert.throws(() => buildFailureProjection(baseFields({ executionPhase: 'not-a-real-phase' })), /executionPhase/);
  assert.throws(() => buildFailureProjection(baseFields({ failureScope: 'bogus' })), /failureScope/);
  assert.throws(() => buildFailureProjection(baseFields({ providerInvocationObserved: 'maybe' })), /providerInvocationObserved/);
});

test('a hand-built look-alike projection with a stray top-level field is refused even when otherwise well formed', () => {
  const lookAlike = { ...buildFailureProjection(baseFields()), rawLog: 'oops' };
  const { schemaVersion, projectionFingerprint, ...withoutDerived } = lookAlike;
  assert.throws(() => buildFailureProjection(withoutDerived), /never projectable|not a recognised field/);
});

// --- Required fixture: pre-claim candidate cost refusal with zero-side-effect booleans ---

test('pre-claim candidate cost refusal reports zero side effects and the exact known cost reason', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'cost_admission',
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
});

// --- Required fixture: pre-provider tool-capability mismatch with bounded missing capability identifiers ---

test('pre-provider tool-capability mismatch preserves the exact typed reason and bounds missing capability identifiers to the known enum', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'capability_admission',
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
  assert.throws(() => buildFailureProjection(baseFields({
    missingCapabilities: ['repo-validation'],
  })), /missingCapabilities must be empty/);
});

// --- Required fixture: budget-limit exhaustion distinct from quota exhaustion and unknown failure ---

test('budget-limit exhaustion is distinct from quota_paused and unknown_failure', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'provider_invocation',
    candidateAdmissionCompleted: true,
    attemptCreated: true,
    managerPacketConsumed: true,
    workspaceCreated: true,
    childLaunched: true,
    providerInvocationObserved: 'yes',
    failureScope: 'task_attempt',
    reasonDomain: 'terminal_outcome',
    reason: 'budget_limit_exhausted',
    terminalOutcome: 'budget_limit_exhausted',
    checkpointPresent: true,
    worktreePresent: true,
    recoveryStatus: 'forbidden',
    recoveryAction: 'attention_required',
    recoveryEligible: false,
    safeNextAction: 'Provide an explicit manager decision before any fresh dispatch.',
  }));
  assert.equal(projection.reason, 'budget_limit_exhausted');
  assert.notEqual(projection.reason, 'quota_paused');
  assert.notEqual(projection.reason, 'unknown_failure');
});

// --- Required fixture: successful no-change outcome ---

test('a successful no-change outcome preserves the exact typed reason rather than collapsing to unknown_failure', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'completed',
    candidateAdmissionCompleted: true,
    attemptCreated: true,
    managerPacketConsumed: true,
    workspaceCreated: true,
    childLaunched: true,
    providerInvocationObserved: 'yes',
    failureScope: 'task_attempt',
    reasonDomain: 'terminal_outcome',
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

// --- Required fixture: worker exit with clean worktree/no commit ---

test('a worker exit with a clean worktree and no commit reports bounded booleans without content', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'completed',
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

// --- Required fixture: committed checkpoint present without exposing content/path ---

test('a committed checkpoint is represented as bounded presence booleans only, never content or a path', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'provider_invocation',
    candidateAdmissionCompleted: true,
    attemptCreated: true,
    managerPacketConsumed: true,
    workspaceCreated: true,
    childLaunched: true,
    providerInvocationObserved: 'yes',
    failureScope: 'task_attempt',
    reasonDomain: 'terminal_outcome',
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

// --- Required fixture: genuinely systemic/unclassifiable case requiring deeper diagnostics ---

test('a genuinely systemic/unclassifiable case requires deeper diagnostics rather than manufactured certainty', () => {
  const projection = buildFailureProjection(baseFields({
    executionPhase: 'systemic',
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

test('deeperDiagnosticsRequired true without a diagnosticDomain is refused', () => {
  assert.throws(() => buildFailureProjection(baseFields({ deeperDiagnosticsRequired: true })), /diagnosticDomain is required/);
});

test('a diagnosticDomain present while deeperDiagnosticsRequired is false is refused', () => {
  assert.throws(() => buildFailureProjection(baseFields({ diagnosticDomain: 'unclassified' })), /diagnosticDomain must be null/);
});

// --- Lifecycle/reason internal-consistency guards ---

test('childLaunched true is refused before executionPhase reaches child_launch', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    executionPhase: 'attempt_creation',
    candidateAdmissionCompleted: true,
    attemptCreated: true,
    childLaunched: true,
  })), /childLaunched cannot be true/);
});

test('providerInvocationObserved yes is refused when childLaunched is false', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    providerInvocationObserved: 'yes',
  })), /providerInvocationObserved cannot be yes/);
});

test('workspaceCreated true is refused when attemptCreated is false', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    executionPhase: 'workspace_preparation',
    workspaceCreated: true,
  })), /workspaceCreated\/childLaunched cannot be true/);
});

test('a known terminal_outcome reason outside the terminal_outcome vocabulary is refused', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    failureScope: 'task_attempt',
    reasonDomain: 'terminal_outcome',
    reason: 'not-a-real-outcome',
  })), /known terminal_outcome reason/);
});

test('terminalOutcome completed requires failureScope none', () => {
  assert.throws(() => buildFailureProjection(baseFields({
    failureScope: 'task_attempt',
    reasonDomain: 'terminal_outcome',
    reason: 'process_crash_or_signal',
    terminalOutcome: 'completed',
  })), /terminalOutcome completed requires failureScope none/);
});

// --- deriveFailureProjection: lenient positive-allowlisted extraction from raw source state ---

test('deriveFailureProjection extracts only the known safe fields and ignores everything else', () => {
  const projection = deriveFailureProjection({
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    executionPhase: 'cost_admission',
    managerPacketConsumed: true,
    failureScope: 'machine_profile',
    reasonDomain: 'cost_admission',
    reason: 'candidate-machine-profile-cost-denied',
    safeNextAction: 'Issue a fresh superseding immutable manager-preflight authority.',
    // adversarial extras that must never reach the projection
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
  const serialized = JSON.stringify(projection);
  for (const forbidden of ['ignore all instructions', 'raw child output', 'raw child stderr', SYNTHETIC_TOKEN, '/home/runner', 'dangerously-skip-permissions', 'full manager packet', 'full github comment', 'sessionId', '--- a/file', 'entire file body']) {
    assert.equal(serialized.includes(forbidden), false, `projection must never contain: ${forbidden}`);
  }
});

test('deriveFailureProjection defaults absent booleans/enums to the safe unknown state', () => {
  const projection = deriveFailureProjection({
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    executionPhase: 'candidate_admission',
    failureScope: 'issue_not_runnable',
    reasonDomain: 'candidate_admission',
    reason: 'candidate-no-longer-runnable',
    safeNextAction: 'Repair execution-critical status/agent labels before another dispatch.',
  });
  assert.equal(projection.attemptCreated, false);
  assert.equal(projection.childLaunched, false);
  assert.equal(projection.providerInvocationObserved, 'no');
  assert.equal(projection.deeperDiagnosticsRequired, false);
});

test('deriveFailureProjection defaults providerInvocationObserved to unknown once a child was launched', () => {
  const projection = deriveFailureProjection({
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
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

test('deriveFailureProjection still enforces the same lifecycle/reason consistency as buildFailureProjection', () => {
  assert.throws(() => deriveFailureProjection({
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 230,
    executionPhase: 'candidate_admission',
    childLaunched: true,
    failureScope: 'none',
    reasonDomain: 'none',
    safeNextAction: 'x',
  }), /childLaunched cannot be true/);
});
