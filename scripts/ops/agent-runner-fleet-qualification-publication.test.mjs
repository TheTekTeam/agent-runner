import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLEET_QUALIFICATION_TARGET_INSTANCES,
  assertNoSecretFields,
  assertPublishedQualificationNonRoutable,
  fleetQualificationPublicationControlSurface,
  publishFleetQualification,
  reconcileAcceptedQualification,
} from './agent-runner-fleet-qualification-publication.mjs';

const CLAUDE_Z790_REVISION = 'claude-z790-7e13ce3be223baf8';
const CODEX_Z790_REVISION = 'codex-z790-58e9d9edf45669ac';

function claudeAcceptedResult(overrides = {}) {
  return {
    accepted: true,
    qualified: true,
    nodeId: 'dev-cluster-z790',
    agentInstanceId: 'claude-code-cli@dev-cluster-z790',
    model: 'sonnet',
    profile: 'narrow',
    effort: 'low',
    baseSha: 'a'.repeat(40),
    jobFingerprint: `sha256:${'1'.repeat(64)}`,
    resultFingerprint: `sha256:${'2'.repeat(64)}`,
    qualificationRevision: CLAUDE_Z790_REVISION,
    evidence: {
      claudeVersion: '2.0.14',
      authMethod: 'claude.ai',
      providerClass: 'anthropic',
      model: 'sonnet',
      profile: 'narrow',
      effort: 'low',
      permissionMode: 'dontAsk',
      toolPolicyFingerprint: `sha256:${'3'.repeat(64)}`,
    },
    ...overrides,
  };
}

function codexAcceptedResult(overrides = {}) {
  return {
    accepted: true,
    qualified: true,
    nodeId: 'dev-cluster-z790',
    agentInstanceId: 'codex-cli@dev-cluster-z790',
    model: 'gpt-5.6-terra',
    profile: 'codex-canary-v1',
    effort: 'low',
    baseSha: 'b'.repeat(40),
    jobFingerprint: `sha256:${'4'.repeat(64)}`,
    resultFingerprint: `sha256:${'5'.repeat(64)}`,
    qualificationRevision: CODEX_Z790_REVISION,
    evidence: {
      codexVersion: 'codex-cli 0.5.1',
      authMode: 'chatgpt',
      model: 'gpt-5.6-terra',
      profile: 'codex-canary-v1',
      effort: 'low',
      sandboxMode: 'workspace-write',
      approvalMode: 'never',
      networkAccess: false,
    },
    ...overrides,
  };
}

test('publication covers exactly the four target fleet instances', () => {
  assert.deepEqual(
    FLEET_QUALIFICATION_TARGET_INSTANCES.map((t) => t.instanceId),
    [
      'claude-code-cli@dev-cluster-dell',
      'claude-code-cli@dev-cluster-z790',
      'codex-cli@dev-cluster-dell',
      'codex-cli@dev-cluster-z790',
    ],
  );
});

test('accepted Z790 evidence publishes qualified-but-disabled non-routable instances', () => {
  const projection = publishFleetQualification({
    acceptedResults: [claudeAcceptedResult(), codexAcceptedResult()],
  });

  const claude = projection.instances.find((i) => i.instanceId === 'claude-code-cli@dev-cluster-z790');
  assert.equal(claude.published, true);
  assert.equal(claude.qualified, true);
  assert.equal(claude.qualificationRevision, CLAUDE_Z790_REVISION);
  assert.equal(claude.installedVersion, '2.0.14');
  assert.equal(claude.providerAccountClass, 'anthropic');
  assert.equal(claude.routable, false);
  assert.equal(claude.lifecycle, 'disabled');

  const codex = projection.instances.find((i) => i.instanceId === 'codex-cli@dev-cluster-z790');
  assert.equal(codex.published, true);
  assert.equal(codex.installedVersion, '0.5.1');
  // Codex live adapter is not qualification-eligible: provisioning state stays
  // non-qualified even though the accepted qualification is published.
  assert.equal(codex.fleetProvisioningState, 'authenticated');
  assert.equal(codex.routable, false);

  assertPublishedQualificationNonRoutable(projection);
  assert.equal(projection.normalRoutingEnabled, false);
});

test('projection is deterministic', () => {
  const a = publishFleetQualification({ acceptedResults: [claudeAcceptedResult(), codexAcceptedResult()] });
  const b = publishFleetQualification({ acceptedResults: [codexAcceptedResult(), claudeAcceptedResult()] });
  assert.equal(a.publicationFingerprint, b.publicationFingerprint);
  assert.deepEqual(a, b);
});

test('Dell Claude and Dell Codex fail closed as explicit bounded evidence gaps', () => {
  const projection = publishFleetQualification({ acceptedResults: [claudeAcceptedResult(), codexAcceptedResult()] });
  const dellClaude = projection.instances.find((i) => i.instanceId === 'claude-code-cli@dev-cluster-dell');
  const dellCodex = projection.instances.find((i) => i.instanceId === 'codex-cli@dev-cluster-dell');
  assert.equal(dellClaude.published, false);
  assert.equal(dellClaude.state, 'evidence-gap');
  assert.match(dellClaude.evidenceGapReason, /dell-claude/);
  assert.equal(dellCodex.published, false);
  assert.match(dellCodex.evidenceGapReason, /dell-codex/);
  assert.equal(dellClaude.routable, false);
  assert.equal(dellCodex.routable, false);
});

test('a Dell-targeted accepted result cannot satisfy a Dell publication path', () => {
  const forged = claudeAcceptedResult({
    nodeId: 'dev-cluster-dell',
    agentInstanceId: 'claude-code-cli@dev-cluster-dell',
    qualificationRevision: 'claude-dell-deadbeefdeadbeef',
  });
  const projection = publishFleetQualification({ acceptedResults: [forged] });
  const dellClaude = projection.instances.find((i) => i.instanceId === 'claude-code-cli@dev-cluster-dell');
  assert.equal(dellClaude.published, false);
  assert.equal(dellClaude.state, 'evidence-gap');
});

test('stale or mismatched qualification revision is refused', () => {
  const stale = claudeAcceptedResult({ qualificationRevision: 'claude-z790-0000000000000000' });
  const r = reconcileAcceptedQualification(FLEET_QUALIFICATION_TARGET_INSTANCES[1], stale);
  assert.deepEqual(r, { ok: false, reason: 'qualification-revision-stale-or-mismatched' });

  const projection = publishFleetQualification({ acceptedResults: [stale] });
  const claude = projection.instances.find((i) => i.instanceId === 'claude-code-cli@dev-cluster-z790');
  assert.equal(claude.published, false);
  assert.equal(claude.evidenceGapReason, 'qualification-revision-stale-or-mismatched');
});

test('per-node isolation: a Z790 result cannot be published against another node', () => {
  const crossNode = claudeAcceptedResult({ nodeId: 'dev-cluster-dell' });
  const r = reconcileAcceptedQualification(FLEET_QUALIFICATION_TARGET_INSTANCES[1], crossNode);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'node-identity-mismatch');
});

test('non-accepted or non-qualified results are refused', () => {
  assert.equal(
    reconcileAcceptedQualification(FLEET_QUALIFICATION_TARGET_INSTANCES[1], claudeAcceptedResult({ accepted: false })).reason,
    'result-not-accepted',
  );
  assert.equal(
    reconcileAcceptedQualification(FLEET_QUALIFICATION_TARGET_INSTANCES[1], claudeAcceptedResult({ qualified: false })).reason,
    'result-not-qualified',
  );
});

test('missing accepted result for a pinned instance yields an evidence gap, not a guess', () => {
  const projection = publishFleetQualification({ acceptedResults: [] });
  for (const entry of projection.instances) {
    assert.equal(entry.published, false);
    assert.equal(entry.qualified, false);
    assert.equal(entry.routable, false);
  }
});

test('serialization guard rejects credential, prompt, session, environment and balance fields', () => {
  for (const key of ['apiKey', 'rawPrompt', 'sessionId', 'environment', 'accountBalance', 'creditRemainingPercent']) {
    assert.throws(() => assertNoSecretFields({ [key]: 'x' }), /forbidden field/);
  }
  assert.throws(() => assertNoSecretFields({ note: 'sk-ant-abcdefghijklmnop1234' }), /forbidden value/);
});

test('published projection contains no secret-bearing fields', () => {
  const projection = publishFleetQualification({ acceptedResults: [claudeAcceptedResult(), codexAcceptedResult()] });
  assert.doesNotThrow(() => assertNoSecretFields(projection));
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /sessionUsedPercent|weeklyUsedPercent|primaryRemainingPercent|RemainingPercent|apiKey|credential/i);
});

test('Z790 gains no scheduler, queue, manager, source-activation or GitHub authority', () => {
  const surface = fleetQualificationPublicationControlSurface();
  for (const key of [
    'workerScheduler', 'workerQueueSelection', 'workerManagerAuthority',
    'workerSourceActivation', 'workerGithubManagementMutation', 'workerMergeCloseDeploy',
    'normalRoutingEnabled', 'paidApiFallbackEnabled',
  ]) {
    assert.equal(surface[key], false);
  }
});

test('duplicate accepted results for one instance are rejected', () => {
  assert.throws(
    () => publishFleetQualification({ acceptedResults: [claudeAcceptedResult(), claudeAcceptedResult()] }),
    /duplicate accepted qualification result/,
  );
});
