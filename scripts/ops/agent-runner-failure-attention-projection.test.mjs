import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attentionProjectionAttemptId,
  renderFailureProjectionSection,
  safeDeriveFailureProjection,
} from './agent-runner-failure-attention-projection.mjs';

const baseCostFields = Object.freeze({
  repository: 'TheTekTeam/agent-runner', issueNumber: 231,
  executionPhase: 'cost_admission',
  candidateAdmissionCompleted: true, attemptCreated: false, workspaceCreated: false, childLaunched: false,
  providerInvocationObserved: 'no',
  failureScope: 'machine_profile', reasonDomain: 'cost_admission', reason: 'candidate-machine-profile-cost-denied',
  checkpointPresent: false, worktreePresent: false, branchPresent: false, commitPresent: false, prPresent: false,
  dirty: false, hasChanges: false,
  recoveryStatus: 'forbidden', recoveryAction: 'attention_required', recoveryEligible: false,
  safeNextAction: 'A changed manager intent requires a fresh superseding immutable manager-preflight authority.',
  deeperDiagnosticsRequired: false,
});

test('safeDeriveFailureProjection builds a valid #230 projection for a pre-claim cost refusal', () => {
  const projection = safeDeriveFailureProjection(baseCostFields);
  assert.ok(projection);
  assert.equal(projection.failureScope, 'machine_profile');
  assert.equal(projection.reason, 'candidate-machine-profile-cost-denied');
  assert.equal(projection.attemptCreated, false);
  assert.equal(projection.childLaunched, false);
  assert.equal(projection.deeperDiagnosticsRequired, false);
});

test('safeDeriveFailureProjection builds a valid projection for a tool-capability mismatch with missing capability ids', () => {
  const projection = safeDeriveFailureProjection({
    ...baseCostFields, executionPhase: 'capability_admission', reasonDomain: 'capability_admission',
    reason: 'implementation-tool-capability-mismatch', missingCapabilities: ['repo-validation'],
  });
  assert.ok(projection);
  assert.deepEqual(projection.missingCapabilities, ['repo-validation']);
});

test('safeDeriveFailureProjection never throws on invalid/incomplete lifecycle evidence -- it returns null', () => {
  assert.equal(safeDeriveFailureProjection({}), null);
  assert.equal(safeDeriveFailureProjection({ ...baseCostFields, executionPhase: 'not-a-real-phase' }), null);
  assert.equal(safeDeriveFailureProjection(null), null);
  assert.equal(safeDeriveFailureProjection(undefined), null);
});

test('attentionProjectionAttemptId sanitizes the real owner/repo#issue:timestamp attempt id shape into a bounded machine-safe token', () => {
  const attemptId = attentionProjectionAttemptId('TheTekTeam/agent-runner#231:2026-08-26T00:00:00.000Z');
  assert.ok(attemptId);
  assert.doesNotMatch(attemptId, /\//);
  assert.match(attemptId, /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$/);
});

test('attentionProjectionAttemptId returns null for absent/non-string input rather than guessing', () => {
  assert.equal(attentionProjectionAttemptId(null), null);
  assert.equal(attentionProjectionAttemptId(undefined), null);
  assert.equal(attentionProjectionAttemptId(''), null);
});

test('renderFailureProjectionSection returns an empty string for a missing or malformed projection', () => {
  assert.equal(renderFailureProjectionSection(null), '');
  assert.equal(renderFailureProjectionSection(undefined), '');
  assert.equal(renderFailureProjectionSection({ schemaVersion: 'not-the-real-one' }), '');
});

test('renderFailureProjectionSection renders only the bounded #230 allowlisted fields', () => {
  const projection = safeDeriveFailureProjection(baseCostFields);
  const section = renderFailureProjectionSection(projection);
  assert.match(section, /Failure projection/);
  assert.match(section, /Incident fingerprint/);
  assert.match(section, /candidate-machine-profile-cost-denied/);
  assert.match(section, /Reason domain: `cost_admission`/);
  assert.match(section, /Attempt created: `false`/);
});

test('renderFailureProjectionSection never surfaces raw provider/log/credential/local-path content, even if adversarially smuggled into a rejected field', () => {
  const projection = safeDeriveFailureProjection(baseCostFields);
  const section = renderFailureProjectionSection(projection);
  const forbidden = [
    /prompt/i, /stdout/i, /stderr/i, /BEGIN [A-Z ]*PRIVATE KEY/, /gh[pousr]_[A-Za-z0-9]{20,}/,
    /\/home\//, /\/Users\//, /~\//, /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(section, pattern);
  // `deriveFailureProjection()` only ever reads its own named lifecycle
  // fields off the source object -- an adversarial extra field (prompt,
  // stdout, a local path) is silently ignored rather than forwarded, so it
  // can never reach the rendered comment even if a careless caller passed it.
  const withAdversarialField = safeDeriveFailureProjection({ ...baseCostFields, prompt: 'secret system prompt', stdout: '/home/gp/secret' });
  assert.ok(withAdversarialField);
  assert.doesNotMatch(renderFailureProjectionSection(withAdversarialField), /secret/i);
});

test('safeDeriveFailureProjection is deterministic: identical fields produce an identical incidentFingerprint (dedupe precondition)', () => {
  const first = safeDeriveFailureProjection(baseCostFields);
  const second = safeDeriveFailureProjection({ ...baseCostFields });
  assert.equal(first.incidentFingerprint, second.incidentFingerprint);
});

test('safeDeriveFailureProjection distinguishes a materially different incident (different reason) with a different incidentFingerprint', () => {
  const first = safeDeriveFailureProjection(baseCostFields);
  const second = safeDeriveFailureProjection({
    ...baseCostFields, executionPhase: 'capability_admission', reasonDomain: 'capability_admission',
    reason: 'implementation-tool-capability-mismatch',
  });
  assert.notEqual(first.incidentFingerprint, second.incidentFingerprint);
});

test('safeDeriveFailureProjection distinguishes a new attempt/revision (different attemptId) from a prior post-attempt incident', () => {
  const postAttemptFields = Object.freeze({
    repository: 'TheTekTeam/agent-runner', issueNumber: 231, executionPhase: 'completed',
    candidateAdmissionCompleted: true, attemptCreated: true, workspaceCreated: true, childLaunched: true,
    providerInvocationObserved: 'yes',
    failureScope: 'task_attempt', reasonDomain: 'terminal_outcome', reason: 'budget_limit_exhausted',
    terminalOutcome: 'budget_limit_exhausted',
    checkpointPresent: true, worktreePresent: true, branchPresent: false, commitPresent: null, prPresent: false,
    recoveryStatus: 'forbidden', recoveryAction: 'attention_required', recoveryEligible: false,
    safeNextAction: 'Review the preserved committed evidence before any further dispatch.',
    deeperDiagnosticsRequired: false,
  });
  const first = safeDeriveFailureProjection({ ...postAttemptFields, attemptId: 'agent-runner-231-attempt-1' });
  const second = safeDeriveFailureProjection({ ...postAttemptFields, attemptId: 'agent-runner-231-attempt-2' });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.incidentFingerprint, second.incidentFingerprint);
});
