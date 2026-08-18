import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNormalizedManagerProfileShape,
  MANAGER_PROFILE_SCHEMA_VERSION,
  validateManagerProfile,
} from './agent-runner-manager-profile-schema.mjs';

function baseProfile(overrides = {}) {
  return {
    schemaVersion: MANAGER_PROFILE_SCHEMA_VERSION,
    projectId: 'sample',
    enabled: true,
    repository: { owner: 'Owner', name: 'Sample' },
    branches: { allowed: ['main'], default: 'main' },
    objective: 'Ship the sample project.',
    nonGoals: ['No autonomous merge'],
    instructionPaths: ['CLAUDE.md'],
    controlIssue: { mode: 'labelSelector', labelSelector: 'status:ready' },
    labels: { ready: 'status:ready', done: 'status:done' },
    capabilities: { allowlist: ['claude-code-cli'] },
    validation: { profile: 'complex', requiredChecks: ['npm test'] },
    quotaPolicyRef: 'scripts/ops/agent-runner-routing.mjs#quota-only-admission',
    mutationBounds: { maxIssueMutationsPerRecurrence: 1, maxCommentsPerRecurrence: 1 },
    escalation: { rules: ['Stop on ambiguous evidence'] },
    mutationAuthority: {
      issueMutation: true,
      authorityIssuance: true,
      merge: false,
      close: false,
      deploy: false,
      sourceActivation: false,
    },
    ...overrides,
  };
}

test('validates a well-formed profile and freezes the result', () => {
  const profile = validateManagerProfile(baseProfile());
  assert.equal(profile.projectId, 'sample');
  assert.equal(profile.repository.full, 'Owner/Sample');
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.mutationAuthority));
});

test('rejects unknown top-level fields', () => {
  assert.throws(
    () => validateManagerProfile(baseProfile({ accountCredit: 100 })),
    /account-credit or balance|not a recognised field/,
  );
});

test('rejects an unknown nested field', () => {
  assert.throws(
    () => validateManagerProfile(baseProfile({ repository: { owner: 'Owner', name: 'Sample', extra: true } })),
    /repository\.extra is not a recognised field/,
  );
});

test('rejects missing required fields', () => {
  const profile = baseProfile();
  delete profile.quotaPolicyRef;
  assert.throws(() => validateManagerProfile(profile), /quotaPolicyRef is required/);
});

test('rejects a repository that is not an exact owner\\/name pair', () => {
  assert.throws(
    () => validateManagerProfile(baseProfile({ repository: { owner: 'Owner/Sub', name: 'Sample' } })),
    /exact owner\/repository pair/,
  );
});

test('rejects an unregistered schema version', () => {
  assert.throws(() => validateManagerProfile(baseProfile({ schemaVersion: 'other/v1' })), /schemaVersion must equal/);
});

test('rejects a default branch that is not in the allowed list', () => {
  assert.throws(
    () => validateManagerProfile(baseProfile({ branches: { allowed: ['main'], default: 'develop' } })),
    /branches\.default must be a member/,
  );
});

test('rejects an account-credit style field even alongside otherwise-valid input', () => {
  assert.throws(() => validateManagerProfile(baseProfile({ balance: 42 })), /not a recognised field|account-credit or balance/);
});

for (const field of ['issueMutation', 'authorityIssuance', 'merge', 'close', 'deploy', 'sourceActivation']) {
  test(`rejects a non-boolean mutationAuthority.${field}`, () => {
    const profile = baseProfile();
    profile.mutationAuthority = { ...profile.mutationAuthority, [field]: 'yes' };
    assert.throws(() => validateManagerProfile(profile), new RegExp(`mutationAuthority\\.${field}`));
  });
}

test('rejects merge/close/deploy/sourceActivation without authorityIssuance', () => {
  const profile = baseProfile();
  profile.mutationAuthority = { ...profile.mutationAuthority, authorityIssuance: false, merge: true };
  assert.throws(() => validateManagerProfile(profile), /require authorityIssuance/);
});

test('rejects deploy without merge', () => {
  const profile = baseProfile();
  profile.mutationAuthority = { ...profile.mutationAuthority, merge: false, deploy: true };
  assert.throws(() => validateManagerProfile(profile), /deploy requires merge/);
});

test('rejects close without issueMutation', () => {
  const profile = baseProfile();
  profile.mutationAuthority = { ...profile.mutationAuthority, issueMutation: false, close: true };
  assert.throws(() => validateManagerProfile(profile), /close requires issueMutation/);
});

test('accepts a fully enabled, safe capability combination', () => {
  const profile = baseProfile();
  profile.mutationAuthority = {
    issueMutation: true,
    authorityIssuance: true,
    merge: true,
    close: true,
    deploy: true,
    sourceActivation: true,
  };
  const validated = validateManagerProfile(profile);
  assert.equal(validated.mutationAuthority.deploy, true);
});

test('rejects an ambiguous control issue (both fixedIssue and labelSelector data)', () => {
  const profile = baseProfile({ controlIssue: { mode: 'fixedIssue', issueNumber: 12, labelSelector: 'status:ready' } });
  assert.throws(() => validateManagerProfile(profile), /labelSelector must not be set/);
});

test('rejects an unrecognised control issue mode', () => {
  assert.throws(
    () => validateManagerProfile(baseProfile({ controlIssue: { mode: 'anything', issueNumber: 1 } })),
    /controlIssue\.mode must be/,
  );
});

test('is deterministic and idempotent for repeated validation of the same input', () => {
  const raw = baseProfile();
  const first = validateManagerProfile(JSON.parse(JSON.stringify(raw)));
  const second = validateManagerProfile(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(first, second);
});

test('every normalized array is itself frozen, not merely its containing object', () => {
  const profile = validateManagerProfile(baseProfile());
  assert.ok(Object.isFrozen(profile.nonGoals));
  assert.ok(Object.isFrozen(profile.instructionPaths));
  assert.ok(Object.isFrozen(profile.branches.allowed));
  assert.ok(Object.isFrozen(profile.capabilities.allowlist));
  assert.ok(Object.isFrozen(profile.validation.requiredChecks));
  assert.ok(Object.isFrozen(profile.escalation.rules));
  assert.throws(() => profile.capabilities.allowlist.push('rogue-agent'), TypeError);
  assert.throws(() => profile.escalation.rules.push('rogue rule'), TypeError);
});

test('assertNormalizedManagerProfileShape refuses an object that merely carries the right schemaVersion', () => {
  assert.throws(
    () => assertNormalizedManagerProfileShape({ schemaVersion: MANAGER_PROFILE_SCHEMA_VERSION, projectId: 'sample' }),
    /already-validated manager profile/,
  );
  assert.throws(
    () => assertNormalizedManagerProfileShape(validateManagerProfile(baseProfile()).mutationAuthority),
    /already-validated manager profile/,
  );
});

test('assertNormalizedManagerProfileShape accepts real validateManagerProfile output', () => {
  assert.doesNotThrow(() => assertNormalizedManagerProfileShape(validateManagerProfile(baseProfile())));
});
