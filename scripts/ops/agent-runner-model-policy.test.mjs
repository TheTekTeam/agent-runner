import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAttemptModelBinding,
  classifyHistoricalModelIdentity,
  inspectModelIdentity,
  registeredClaudeCompatibilityAliases,
  resolveQualifiedProfileCandidate,
} from './agent-runner-model-policy.mjs';

const exactQualification = {
  qualified: true,
  revision: 'claude-exact-model-dell-1',
  adapterId: 'claude-code-cli',
  modelId: 'verified-exact-model',
  cliVersion: 'current-cli-version',
  documentationRevision: 'official-docs-verified-revision',
  documentationVerified: true,
  supportedEfforts: ['low', 'medium'],
};

test('live Claude aliases remain compatibility identities without being reinterpreted as exact models', () => {
  for (const modelId of ['haiku', 'sonnet', 'opus']) {
    const identity = inspectModelIdentity({ adapterId: 'claude-code-cli', modelId });
    assert.equal(identity.state, 'compatibility-alias');
    assert.equal(identity.selectable, true);
    assert.equal(identity.exactIdentity, false);
    assert.equal(identity.historical, true);
    assert.equal(identity.qualificationRevision, null);
    assert.equal(identity.documentationRevision, null);
    assert.deepEqual(identity.supportedEfforts, []);
    assert.equal(classifyHistoricalModelIdentity({ adapterId: 'claude-code-cli', modelId }).historicallyValid, true);
  }
  assert.equal(inspectModelIdentity({ adapterId: 'claude-code-cli', modelId: 'opus' }).requiresExplicitMachineOptIn, true);
});

test('no unverified exact model name becomes selectable without current docs plus installed CLI qualification', () => {
  const candidate = inspectModelIdentity({ adapterId: 'claude-code-cli', modelId: 'unverified-exact-model' });
  assert.equal(candidate.state, 'unsupported');
  assert.equal(candidate.selectable, false);
  assert.equal(candidate.exactIdentity, true);
  assert.equal(candidate.reason, 'exact-model-documentation-and-cli-qualification-required');
});

test('exact model qualification binds documentation, installed CLI, adapter and model identity', () => {
  const qualified = inspectModelIdentity({
    adapterId: 'claude-code-cli',
    modelId: 'verified-exact-model',
    qualification: exactQualification,
  });
  assert.equal(qualified.state, 'qualified');
  assert.equal(qualified.selectable, true);
  assert.equal(qualified.exactIdentity, true);
  assert.equal(qualified.qualificationRevision, 'claude-exact-model-dell-1');
  assert.equal(qualified.cliVersion, 'current-cli-version');
  assert.equal(qualified.documentationRevision, 'official-docs-verified-revision');
  assert.deepEqual(qualified.supportedEfforts, ['low', 'medium']);

  assert.equal(inspectModelIdentity({
    adapterId: 'claude-code-cli',
    modelId: 'different-exact-model',
    qualification: exactQualification,
  }).selectable, false);

  assert.equal(inspectModelIdentity({
    adapterId: 'codex-cli',
    modelId: 'verified-exact-model',
    qualification: exactQualification,
  }).state, 'unsupported');
});

test('documentation evidence is mandatory and cannot be inferred from qualified=true', () => {
  for (const patch of [
    { documentationVerified: false },
    { documentationRevision: null },
    { cliVersion: null },
    { revision: null },
  ]) {
    const identity = inspectModelIdentity({
      adapterId: 'claude-code-cli',
      modelId: 'verified-exact-model',
      qualification: { ...exactQualification, ...patch },
    });
    assert.equal(identity.state, 'unsupported');
    assert.equal(identity.selectable, false);
  }
});

test('profile migration helper never chooses a model name itself', () => {
  const refused = resolveQualifiedProfileCandidate({
    profileName: 'narrow',
    modelId: 'unverified-exact-model',
    effort: 'low',
  });
  assert.equal(refused.selected, false);
  assert.equal(refused.reason, 'exact-qualified-model-required');

  const selected = resolveQualifiedProfileCandidate({
    profileName: 'narrow',
    modelId: 'verified-exact-model',
    effort: 'low',
    qualification: exactQualification,
  });
  assert.equal(selected.selected, true);
  assert.equal(selected.modelId, 'verified-exact-model');
  assert.equal(selected.effort, 'low');
});

test('exact model effort must be independently qualified', () => {
  const result = resolveQualifiedProfileCandidate({
    profileName: 'complex',
    modelId: 'verified-exact-model',
    effort: 'high',
    qualification: exactQualification,
  });
  assert.equal(result.selected, false);
  assert.equal(result.reason, 'profile-effort-not-qualified');
});

test('machine-local opt-in remains a separate gate when qualification requires it', () => {
  const qualification = { ...exactQualification, requiresExplicitMachineOptIn: true };
  const blocked = resolveQualifiedProfileCandidate({
    profileName: 'critical',
    modelId: 'verified-exact-model',
    effort: 'medium',
    qualification,
  });
  assert.equal(blocked.selected, false);
  assert.equal(blocked.reason, 'model-requires-explicit-machine-opt-in');

  const admitted = resolveQualifiedProfileCandidate({
    profileName: 'critical',
    modelId: 'verified-exact-model',
    effort: 'medium',
    qualification,
    allowExplicitMachineOptIn: true,
  });
  assert.equal(admitted.selected, true);
});

test('captured attempt model identity is immutable for aliases and exact identities', () => {
  assert.equal(assertAttemptModelBinding({
    capturedModelId: 'sonnet',
    requestedModelId: 'sonnet',
  }), 'sonnet');
  assert.equal(assertAttemptModelBinding({
    capturedModelId: 'verified-exact-model',
    requestedModelId: 'verified-exact-model',
  }), 'verified-exact-model');
  assert.throws(() => assertAttemptModelBinding({
    capturedModelId: 'sonnet',
    requestedModelId: 'verified-exact-model',
  }), /attempt model identity changed after capture/);
});

test('invalid qualification effort identities fail closed rather than being guessed', () => {
  assert.throws(() => inspectModelIdentity({
    adapterId: 'claude-code-cli',
    modelId: 'verified-exact-model',
    qualification: { ...exactQualification, supportedEfforts: ['turbo'] },
  }), /unsupported effort identity/);
});

test('compatibility registry contains only the aliases already accepted by the live runner', () => {
  const values = registeredClaudeCompatibilityAliases();
  assert.deepEqual(values.map((entry) => entry.modelId), ['haiku', 'sonnet', 'opus']);
  assert.equal(values.every((entry) => entry.adapterId === 'claude-code-cli'), true);
  assert.equal(values.every((entry) => entry.capabilityTier === 'compatibility-alias'), true);
});

test('unknown provider model policy remains outside this Claude qualification slice', () => {
  const identity = inspectModelIdentity({
    adapterId: 'codex-cli',
    modelId: 'some-model',
    qualification: {
      ...exactQualification,
      adapterId: 'codex-cli',
      modelId: 'some-model',
    },
  });
  assert.equal(identity.state, 'unsupported');
  assert.equal(identity.reason, 'adapter-model-policy-not-qualified-here');
});
