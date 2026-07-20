import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAILURE_SCOPES,
  admitMachineProfile,
  machineProfilePausePayload,
  normalizeImplementationApprovers,
} from './agent-runner-admission.mjs';

test('dry-run inspection is admitted without implementation opt-in', () => {
  const result = admitMachineProfile({ argv: ['--dry-run'], env: {} });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'dry-run');
});

test('disabled implementation pauses the profile before selection or mutation', () => {
  const result = admitMachineProfile({ argv: ['--execute'], env: {} });
  assert.equal(result.allowed, false);
  assert.equal(result.scope, FAILURE_SCOPES.MACHINE_PROFILE);
  assert.equal(result.reason, 'implementation-machine-opt-in-disabled');
  assert.match(result.configurationFingerprint, /^sha256:[a-f0-9]{64}$/);

  const payload = machineProfilePausePayload(result);
  assert.equal(payload.selectedIssue, null);
  assert.equal(payload.childLaunched, false);
  assert.equal(payload.issueMutation, false);
  assert.equal(payload.systemdOutcome, 'handled');
});

test('missing approvers pauses an otherwise enabled profile', () => {
  const result = admitMachineProfile({
    argv: ['--execute'],
    env: { CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true' },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'implementation-approver-allowlist-empty');
});

test('malformed approvers are rejected deterministically', () => {
  const result = admitMachineProfile({
    argv: ['--execute'],
    env: {
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola,Not Valid',
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'implementation-approver-allowlist-invalid');
});

test('generated-preflight implementation is prohibited even when implementation is enabled', () => {
  const result = admitMachineProfile({
    argv: ['--execute'],
    env: {
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
      CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION: 'true',
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'generated-preflight-implementation-prohibited');
});

test('valid machine profile proceeds to candidate-specific admission', () => {
  const result = admitMachineProfile({
    argv: ['--execute'],
    env: {
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'GPCOLA,gpcola,other-user',
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'machine-profile-admitted');
});

test('approvers normalize to lowercase unique GitHub logins', () => {
  assert.deepEqual(normalizeImplementationApprovers('GPCOLA, gpcola other-user'), {
    approvers: ['gpcola', 'other-user'],
    invalid: [],
  });
});
