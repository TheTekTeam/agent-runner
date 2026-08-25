import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAttemptModelBinding,
  classifyHistoricalModelIdentity,
  inspectModelIdentity,
  registeredClaudeModelIdentities,
  resolveProfileModelCandidate,
} from './agent-runner-model-policy.mjs';

const sonnetQualification = {
  qualified: true,
  revision: 'claude-sonnet5-dell-1',
  adapterId: 'claude-code-cli',
  modelId: 'claude-sonnet-5',
  cliVersion: '2.1.233',
};

const opusQualification = {
  qualified: true,
  revision: 'claude-opus5-dell-1',
  adapterId: 'claude-code-cli',
  modelId: 'claude-opus-5',
  cliVersion: '2.1.233',
};

test('current explicit Claude identities are candidates until exact installed-CLI qualification exists', () => {
  const candidate = inspectModelIdentity({ adapterId: 'claude-code-cli', modelId: 'claude-sonnet-5' });
  assert.equal(candidate.state, 'candidate');
  assert.equal(candidate.selectable, false);
  assert.equal(candidate.reason, 'exact-installed-cli-qualification-required');

  const qualified = inspectModelIdentity({
    adapterId: 'claude-code-cli',
    modelId: 'claude-sonnet-5',
    qualification: sonnetQualification,
  });
  assert.equal(qualified.state, 'qualified');
  assert.equal(qualified.selectable, true);
  assert.equal(qualified.qualificationRevision, 'claude-sonnet5-dell-1');
});

test('qualification is bound to exact adapter and model rather than a generic provider approval', () => {
  assert.equal(inspectModelIdentity({
    adapterId: 'claude-code-cli',
    modelId: 'claude-opus-5',
    qualification: sonnetQualification,
  }).selectable, false);

  assert.equal(inspectModelIdentity({
    adapterId: 'codex-cli',
    modelId: 'claude-sonnet-5',
    qualification: sonnetQualification,
  }).state, 'unsupported');
});

test('historical aliases remain verifiable but cannot become new-attempt selections', () => {
  for (const modelId of ['haiku', 'sonnet', 'opus']) {
    const identity = inspectModelIdentity({ adapterId: 'claude-code-cli', modelId });
    assert.equal(identity.state, 'historically-valid');
    assert.equal(identity.historical, true);
    assert.equal(identity.selectable, false);
    assert.equal(classifyHistoricalModelIdentity({ adapterId: 'claude-code-cli', modelId }).historicallyValid, true);
  }
});

test('unknown and cross-adapter identities fail closed', () => {
  assert.deepEqual(inspectModelIdentity({ adapterId: 'claude-code-cli', modelId: 'future-unknown' }), {
    schemaVersion: 1,
    adapterId: 'claude-code-cli',
    modelId: 'future-unknown',
    state: 'unsupported',
    selectable: false,
    historical: false,
    qualificationRevision: null,
    reason: 'model-not-registered-for-adapter',
  });
});

test('profile candidates do not change live defaults before exact qualification', () => {
  const docs = resolveProfileModelCandidate('docs');
  assert.equal(docs.selected, false);
  assert.equal(docs.candidate.modelId, 'claude-sonnet-5');

  const qualified = resolveProfileModelCandidate('docs', { qualification: sonnetQualification });
  assert.equal(qualified.selected, true);
  assert.equal(qualified.candidate.effort, 'low');
});

test('critical Opus requires both exact model qualification and explicit machine-local opt-in', () => {
  const noOptIn = resolveProfileModelCandidate('critical', { qualification: opusQualification });
  assert.equal(noOptIn.selected, false);
  assert.equal(noOptIn.reason, 'opus-requires-explicit-machine-opt-in');

  const admitted = resolveProfileModelCandidate('critical', { qualification: opusQualification, allowOpus: true });
  assert.equal(admitted.selected, true);
  assert.equal(admitted.candidate.modelId, 'claude-opus-5');
  assert.equal(admitted.candidate.effort, 'high');
});

test('captured attempt model identity is immutable', () => {
  assert.equal(assertAttemptModelBinding({
    capturedModelId: 'claude-sonnet-5',
    requestedModelId: 'claude-sonnet-5',
  }), 'claude-sonnet-5');
  assert.throws(() => assertAttemptModelBinding({
    capturedModelId: 'claude-sonnet-5',
    requestedModelId: 'claude-opus-5',
  }), /attempt model identity changed after capture/);
});

test('registry distinguishes exact current identities from historical aliases', () => {
  const values = registeredClaudeModelIdentities();
  assert.deepEqual(values.map((entry) => entry.modelId), [
    'claude-sonnet-5',
    'claude-opus-5',
    'haiku',
    'sonnet',
    'opus',
  ]);
  assert.equal(values.find((entry) => entry.modelId === 'claude-sonnet-5').historical, false);
  assert.equal(values.find((entry) => entry.modelId === 'sonnet').historical, true);
});
