import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MERGE_HUMAN_GATE_NAMES, evaluateMergeEligibility, normalizeMergeDecisionRequest,
} from './agent-runner-merge-policy.mjs';

const NO_GATES = Object.freeze(Object.fromEntries(MERGE_HUMAN_GATE_NAMES.map((name) => [name, false])));

const request = (overrides) => normalizeMergeDecisionRequest({
  projectId: 'alpha-prj', repository: 'Owner/alpha', issueNumber: 155, prNumber: 42,
  sourceBranch: 'codex/pr-155', targetBranch: 'main', expectedHeadSha: 'a'.repeat(40), expectedBaseSha: 'b'.repeat(40),
  managerRevision: 'AR155-MERGE-2026-08-09.1', managerFingerprint: `sha256:${'c'.repeat(64)}`,
  executorJobId: 'executor-job-00000001', requestId: 'request-0000000001', riskClass: 'R1',
  gates: NO_GATES, automaticMergeAuthority: true,
  requiredValidationProfiles: [{ profile: 'focused', validationId: 'validation-00000001' }],
  mergeMethod: 'squash', requiredApprovals: 1,
  approvedScope: 'Merge the exact-head validated implementation for issue #155.',
  ...overrides,
});

test('normalizeMergeDecisionRequest freezes a well-formed request and derives a stable identity', () => {
  const a = request();
  const b = request();
  assert.equal(a.transactionId, b.transactionId);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.gates));
  const differentHead = request({ expectedHeadSha: 'd'.repeat(40) });
  assert.notEqual(a.transactionId, differentHead.transactionId);
});

test('normalizeMergeDecisionRequest fails closed on missing or malformed required fields', () => {
  assert.throws(() => request({ riskClass: undefined }), (e) => e.code === 'invalid-request');
  assert.throws(() => request({ gates: { ...NO_GATES, secretCredential: undefined } }), (e) => e.code === 'invalid-request');
  assert.throws(() => request({ automaticMergeAuthority: 'yes' }), (e) => e.code === 'invalid-request');
  assert.throws(() => request({ mergeMethod: 'fast-forward' }), (e) => e.code === 'invalid-request');
  assert.throws(() => request({ sourceBranch: 'main', targetBranch: 'main' }), (e) => e.code === 'invalid-request');
  assert.throws(() => request({ requiredValidationProfiles: [] }), (e) => e.code === 'invalid-request');
});

test('evaluateMergeEligibility is default-deny: only R0/R1/R2 with explicit true authority and no gates is eligible', () => {
  assert.equal(evaluateMergeEligibility(request()).eligible, true);
  assert.equal(evaluateMergeEligibility(request({ riskClass: 'R0' })).eligible, true);
  assert.equal(evaluateMergeEligibility(request({ riskClass: 'R2' })).eligible, true);
});

test('evaluateMergeEligibility refuses R3/R4 regardless of authority or gates', () => {
  for (const riskClass of ['R3', 'R4']) {
    const decision = evaluateMergeEligibility(request({ riskClass }));
    assert.equal(decision.eligible, false, riskClass);
    assert.equal(decision.reasonCode, 'high-risk-classification', riskClass);
  }
});

test('evaluateMergeEligibility refuses whenever any human gate is true', () => {
  for (const name of MERGE_HUMAN_GATE_NAMES) {
    const decision = evaluateMergeEligibility(request({ gates: { ...NO_GATES, [name]: true } }));
    assert.equal(decision.eligible, false, name);
    assert.equal(decision.reasonCode, 'human-gate-required', name);
  }
});

test('evaluateMergeEligibility refuses without explicit positive automatic-merge authority', () => {
  const decision = evaluateMergeEligibility(request({ automaticMergeAuthority: false }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, 'automatic-merge-authority-missing');
});
