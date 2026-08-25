import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH,
  admitCurrentCandidate,
  candidatePausePayload,
  candidateSnapshot,
  evaluateCandidateAdmission,
  evaluateCandidateCapabilityAdmission,
} from './agent-runner-candidate-admission.mjs';
import {
  CandidateAdmissionPausedError,
  createAtomicAdmissionStore,
  snapshotFromSelectionRecord,
} from './agent-runner-atomic-candidate-store.mjs';
import {
  CAPABILITY_BOUNDED_BENCHMARK_RUN,
  CAPABILITY_DEPENDENCY_ANCESTRY_READ,
  CAPABILITY_DEPENDENCY_AUDIT_READ,
  CAPABILITY_HOST_FINGERPRINT_READ,
  CAPABILITY_PACKAGE_INSTALL_FROZEN,
  CAPABILITY_PACKAGE_RESOLUTION_UPDATE,
} from './claude-runner-capability-model.mjs';

const FP = `sha256:${'a'.repeat(64)}`;

function preflight(requiredCapabilities = [], { id = 901, approvedAgent = 'claude-code-cli' } = {}) {
  const capabilityBlock = requiredCapabilities.length
    ? `required_capabilities:\n${requiredCapabilities.map((value) => `  - ${value}`).join('\n')}\n`
    : '';
  return {
    id,
    databaseId: id,
    createdAt: '2026-08-25T19:00:00Z',
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: AR229-${id}\nfingerprint: ${FP}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: ${approvedAgent}\nexecution_phase: implementation\nprofile: narrow\nmodel: sonnet\neffort: low\n${capabilityBlock}scope:\n  - bounded capability admission fixture\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on authority expansion\n\`\`\``,
  };
}

function selection(requiredCapabilities = [], options = {}) {
  const packet = preflight(requiredCapabilities, options);
  return {
    issue: {
      number: 229,
      title: 'bounded candidate capability fixture',
      labels: ['status:ready', 'agent:claude'],
      statusLabel: 'status:ready',
      agentLabel: 'agent:claude',
    },
    selection: { mode: 'preflight-direct', command: null, preflight: packet },
    command: null,
    currentPreflight: packet,
  };
}

test('#229 baseline candidate with no extra capabilities remains admitted', () => {
  const result = evaluateCandidateCapabilityAdmission({ preflight: preflight([]) });
  assert.equal(result.allowed, true);
  assert.deepEqual([...result.requiredCapabilities], []);
  assert.deepEqual([...result.missingCapabilities], []);
});

test('#229 ModelSpend #792 capability class is admitted only from the accepted available mappings', () => {
  const required = [
    CAPABILITY_DEPENDENCY_AUDIT_READ,
    CAPABILITY_DEPENDENCY_ANCESTRY_READ,
    CAPABILITY_PACKAGE_INSTALL_FROZEN,
    CAPABILITY_PACKAGE_RESOLUTION_UPDATE,
  ];
  const result = evaluateCandidateCapabilityAdmission({ preflight: preflight(required) });
  assert.equal(result.allowed, true);
  assert.deepEqual([...result.requiredCapabilities], [...required].sort());
  assert.deepEqual([...result.missingCapabilities], []);
  assert.deepEqual([...result.unavailableCapabilities], []);
});

test('#229 ModelSpend #784 capability class refuses unavailable benchmark authority before provider launch', () => {
  const result = evaluateCandidateCapabilityAdmission({
    preflight: preflight([CAPABILITY_HOST_FINGERPRINT_READ, CAPABILITY_BOUNDED_BENCHMARK_RUN]),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.scope, 'machine_profile');
  assert.equal(result.reason, IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH);
  assert.deepEqual([...result.missingCapabilities], [CAPABILITY_BOUNDED_BENCHMARK_RUN]);
  assert.deepEqual([...result.unavailableCapabilities], [CAPABILITY_BOUNDED_BENCHMARK_RUN]);
  assert.equal(result.childLaunched, false);
  assert.equal(result.providerInvocation, false);
  assert.match(result.safeNextAction, /reviewed bounded tool\/harness mapping/i);
});

test('#229 unknown manager capability fails closed instead of being inferred or ignored', () => {
  const result = evaluateCandidateCapabilityAdmission({
    preflight: preflight([CAPABILITY_DEPENDENCY_AUDIT_READ, 'network-unrestricted']),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH);
  assert.deepEqual([...result.unknownCapabilities], ['network-unrestricted']);
  assert.equal(result.childLaunched, false);
});

test('#229 does not infer the Claude capability contract for another adapter', () => {
  const result = evaluateCandidateCapabilityAdmission({
    preflight: preflight([CAPABILITY_DEPENDENCY_AUDIT_READ], { approvedAgent: 'codex-cli' }),
    adapterId: 'codex-cli',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH);
  assert.deepEqual([...result.missingCapabilities], [CAPABILITY_DEPENDENCY_AUDIT_READ]);
});

test('#229 atomic candidate path reports benchmark mismatch with zero attempt/child/provider/GitHub mutation', async () => {
  const values = [
    selection([CAPABILITY_HOST_FINGERPRINT_READ, CAPABILITY_BOUNDED_BENCHMARK_RUN]),
    selection([CAPABILITY_HOST_FINGERPRINT_READ, CAPABILITY_BOUNDED_BENCHMARK_RUN]),
  ];
  let calls = 0;
  const result = await admitCurrentCandidate({
    env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola' },
    select: async () => values[calls++],
  });
  assert.equal(calls, 2);
  assert.equal(result.admission.allowed, false);
  assert.equal(result.admission.reason, IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH);
  assert.deepEqual([...result.admission.missingCapabilities], [CAPABILITY_BOUNDED_BENCHMARK_RUN]);

  const payload = candidatePausePayload(result.admission, result.current);
  assert.equal(payload.failureScope, 'machine_profile');
  assert.equal(payload.selectedIssue, 229);
  assert.equal(payload.attemptCreated, false);
  assert.equal(payload.childLaunched, false);
  assert.equal(payload.providerInvocation, false);
  assert.equal(payload.issueMutation, false);
  assert.equal(payload.systemdOutcome, 'handled');
});

test('#229 #792-style available capability set reaches the existing next admission gate', async () => {
  const required = [
    CAPABILITY_DEPENDENCY_AUDIT_READ,
    CAPABILITY_DEPENDENCY_ANCESTRY_READ,
    CAPABILITY_PACKAGE_INSTALL_FROZEN,
    CAPABILITY_PACKAGE_RESOLUTION_UPDATE,
  ];
  const values = [selection(required), selection(required)];
  let calls = 0;
  const result = await admitCurrentCandidate({
    env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola' },
    select: async () => values[calls++],
  });
  assert.equal(calls, 2);
  assert.equal(result.admission.allowed, true);
});

test('#229 capability denial prevents the underlying atomic store from recording an attempt', () => {
  let recoveryAttempts = 0;
  const pauseState = { result: null };
  const store = {
    recordIssueSelection: (record) => record,
    recordRecoveryAttempt: () => { recoveryAttempts += 1; },
  };
  const denied = {
    admission: {
      allowed: false,
      scope: 'machine_profile',
      reason: IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH,
      requiredCapabilities: [CAPABILITY_BOUNDED_BENCHMARK_RUN],
      grantedCapabilities: [],
      missingCapabilities: [CAPABILITY_BOUNDED_BENCHMARK_RUN],
      unavailableCapabilities: [CAPABILITY_BOUNDED_BENCHMARK_RUN],
      unknownCapabilities: [],
      safeNextAction: 'review capability contract',
    },
    current: { issueNumber: 229 },
  };
  const wrapped = createAtomicAdmissionStore(store, {
    pauseState,
    revalidate: () => denied,
  });
  const selected = selection([CAPABILITY_BOUNDED_BENCHMARK_RUN]);
  const snap = candidateSnapshot(selected);
  wrapped.recordIssueSelection({
    issueNumber: 229,
    statusLabel: snap.statusLabel,
    selectionMode: snap.selectionMode,
    commandKind: null,
    sourceCommentIdentity: null,
    sourcePreflightCommentIdentity: snap.preflightIdentity,
    sourcePreflightRevision: snap.preflightRevision,
    sourcePreflightFingerprint: snap.preflightFingerprint,
    sourcePreflightAuthorityKey: snap.preflightAuthorityKey,
    sourcePreflightBodyDigest: snap.preflightBodyDigest,
    sourcePreflightApprovedAgent: snap.preflightApprovedAgent,
    sourcePreflightPacketValid: snap.preflightPacketValid,
    sourcePreflightAuthor: snap.preflightAuthor,
    agentLabel: snap.agentLabel,
    payload: {
      selectedIssue: 229,
      selectedStatusLabel: snap.statusLabel,
      selectedAgentLabel: snap.agentLabel,
      selectionMode: snap.selectionMode,
      agent: { agentId: snap.resolvedAgentId },
    },
  });
  assert.throws(() => wrapped.recordRecoveryAttempt({
    issueNumber: 229,
    phase: 'starting',
    resolutionState: 'active',
    finishedAt: null,
  }), CandidateAdmissionPausedError);
  assert.equal(recoveryAttempts, 0);
  assert.equal(pauseState.result.admission.reason, IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH);
});

test('#229 identity authority is still evaluated before capability admission', () => {
  const initial = candidateSnapshot(selection([CAPABILITY_BOUNDED_BENCHMARK_RUN]));
  const current = candidateSnapshot(selection([CAPABILITY_BOUNDED_BENCHMARK_RUN]));
  current.preflightApprovedAgent = 'codex-cli';
  const identity = evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] });
  assert.equal(identity.allowed, false);
  assert.equal(identity.reason, 'candidate-preflight-agent-not-approved');
});

test('#229 selection-record snapshots remain compatible with the existing atomic identity boundary', () => {
  const selected = selection([]);
  const snap = candidateSnapshot(selected);
  const restored = snapshotFromSelectionRecord({
    issueNumber: 229,
    statusLabel: snap.statusLabel,
    selectionMode: snap.selectionMode,
    commandKind: null,
    sourcePreflightCommentIdentity: snap.preflightIdentity,
    sourcePreflightRevision: snap.preflightRevision,
    sourcePreflightFingerprint: snap.preflightFingerprint,
    sourcePreflightAuthorityKey: snap.preflightAuthorityKey,
    sourcePreflightBodyDigest: snap.preflightBodyDigest,
    sourcePreflightApprovedAgent: snap.preflightApprovedAgent,
    sourcePreflightPacketValid: snap.preflightPacketValid,
    sourcePreflightAuthor: snap.preflightAuthor,
    agentLabel: snap.agentLabel,
    payload: { agent: { agentId: snap.resolvedAgentId } },
  });
  assert.equal(restored.issueNumber, snap.issueNumber);
  assert.equal(restored.resolvedAgentId, snap.resolvedAgentId);
  assert.equal(restored.preflightAuthorityKey, snap.preflightAuthorityKey);
});
