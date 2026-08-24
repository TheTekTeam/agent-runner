import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAcceptedStateCapsule,
  buildBoundedContextCapsule,
  buildContinuationDelta,
  chooseContextBudget,
  contextBudgetTelemetry,
  decideSessionLifecycle,
  normalizeModelVisibleResult,
  shouldStopProvider,
} from './agent-runner-context-budget.mjs';

const task = {
  projectId: 'agent-runner',
  githubRepo: 'TheTekTeam/agent-runner',
  issueNumber: 320,
  prNumber: 332,
  branch: 'chatgpt/context-budget-320',
  sourceFingerprint: `sha256:${'1'.repeat(64)}`,
  authorityRevision: 'AR-320',
};

const session = {
  sessionId: 'session-320',
  identity: task,
  adapterRevision: 'claude-v1',
  model: 'sonnet',
  toolPolicyFingerprint: 'tools-v1',
  systemFingerprint: 'system-v1',
  relevance: 'high',
};

const provider = {
  adapterRevision: 'claude-v1',
  model: 'sonnet',
  toolPolicyFingerprint: 'tools-v1',
  systemFingerprint: 'system-v1',
  compactionSupported: true,
};

test('new unrelated issue never inherits another task session', () => {
  const result = decideSessionLifecycle({
    taskIdentity: { ...task, issueNumber: 321 },
    session,
    provider,
  });
  assert.equal(result.decision, 'fresh-task');
  assert.equal(result.resume, false);
});

test('exact recovery resumes only the bound session', () => {
  const exact = decideSessionLifecycle({
    taskIdentity: task,
    session,
    provider,
    recovery: { requiresExactSession: true, sessionId: 'session-320' },
  });
  assert.equal(exact.decision, 'same-attempt-continuation');
  assert.equal(exact.resume, true);

  const mismatch = decideSessionLifecycle({
    taskIdentity: task,
    session,
    provider,
    recovery: { requiresExactSession: true, sessionId: 'wrong' },
  });
  assert.equal(mismatch.resume, false);
  assert.equal(mismatch.decision, 'provider-context-incompatible');
});

test('long stale session compacts when supported and starts fresh when unsupported', () => {
  const compact = decideSessionLifecycle({ taskIdentity: task, session, provider, context: { utilisation: 0.8 } });
  assert.equal(compact.decision, 'context-stale');
  assert.equal(compact.compact, true);
  assert.equal(compact.resume, true);

  const fresh = decideSessionLifecycle({ taskIdentity: task, session, provider: { ...provider, compactionSupported: false }, context: { utilisation: 0.8 } });
  assert.equal(fresh.decision, 'context-stale');
  assert.equal(fresh.compact, false);
  assert.equal(fresh.resume, false);
});

test('provider/system/tool/model revision mismatch prevents stale session reuse', () => {
  for (const changed of [
    { adapterRevision: 'claude-v2' },
    { model: 'other-model' },
    { toolPolicyFingerprint: 'tools-v2' },
    { systemFingerprint: 'system-v2' },
  ]) {
    const result = decideSessionLifecycle({ taskIdentity: task, session, provider: { ...provider, ...changed } });
    assert.equal(result.decision, 'provider-context-incompatible');
    assert.equal(result.resume, false);
  }
});

test('high-relevance same-PR correction resumes a compatible small session', () => {
  const result = decideSessionLifecycle({ taskIdentity: task, session, provider, context: { utilisation: 0.25 } });
  assert.equal(result.decision, 'same-pr-correction');
  assert.equal(result.resume, true);
});

test('task class selects bounded reasoning, turn and output budgets without guessing unsupported provider flags', () => {
  const narrow = chooseContextBudget({
    taskClass: 'narrow',
    adapterCapabilities: { maxTurns: true, reasoningEffort: true, outputBudget: false },
  });
  assert.equal(narrow.reasoningEffort, 'low');
  assert.ok(narrow.maxTurns < chooseContextBudget({ taskClass: 'complex' }).maxTurns);
  assert.equal(narrow.providerControls.maxTurns, narrow.maxTurns);
  assert.equal(narrow.providerControls.outputBudgetBytes, null);
  assert.ok(narrow.unsupportedControls.includes('outputBudgetBytes'));

  const security = chooseContextBudget({ taskClass: 'narrow', risk: 'security', adapterCapabilities: { reasoningEffort: true } });
  assert.equal(security.reasoningEffort, 'high');
});

test('hard context capsule prioritises required authority/task/source and refuses unsafe truncation', () => {
  const budget = { maxContextBytes: 2048 };
  const capsule = buildBoundedContextCapsule({
    budget,
    sections: [
      { kind: 'hints', value: 'x'.repeat(4000), maxBytes: 512 },
      { kind: 'authority', value: 'authority=AR-320', required: true },
      { kind: 'task', value: 'issue=#320', required: true },
      { kind: 'source', value: 'sha=abc', required: true },
      { kind: 'validation', value: 'pass' },
    ],
  });
  assert.ok(capsule.bytes <= budget.maxContextBytes);
  assert.deepEqual(capsule.sections.slice(0, 3).map((section) => section.kind), ['authority', 'task', 'source']);
  assert.equal(capsule.sections.some((section) => section.kind === 'hints' && section.truncated), true);

  assert.throws(() => buildBoundedContextCapsule({
    budget: { maxContextBytes: 64 },
    sections: [{ kind: 'authority', value: 'required'.repeat(100), required: true }],
  }), /required context section/);
});

test('unchanged non-required evidence is referenced by digest rather than retransmitted', () => {
  const value = 'validation=green';
  const first = buildBoundedContextCapsule({ budget: { maxContextBytes: 2048 }, sections: [{ kind: 'validation', value }] });
  const digest = first.sections[0].digest;
  const second = buildBoundedContextCapsule({
    budget: { maxContextBytes: 2048 },
    sections: [{ kind: 'validation', value }],
    priorAcceptedEvidence: [digest],
  });
  assert.equal(second.sections[0].omittedAsUnchanged, true);
  assert.equal(second.sections[0].unchangedEvidenceRef, digest);
  assert.equal(JSON.stringify(second).includes(value), false);
});

test('large deterministic output is normalized by default and can escalate only to larger bounded views', () => {
  const raw = `failure\n${'detail '.repeat(5000)}`;
  const normal = normalizeModelVisibleResult({ kind: 'test', status: 'failed', target: 'unit', output: raw });
  assert.equal(normal.truncated, true);
  assert.equal(normal.escalationAvailable, true);
  assert.ok(Buffer.byteLength(normal.diagnostic) <= 1600);
  const expanded = normalizeModelVisibleResult({ kind: 'test', status: 'failed', target: 'unit', output: raw, level: 'expanded' });
  assert.ok(expanded.diagnostic.length > normal.diagnostic.length);
  assert.ok(expanded.diagnostic.length <= 6000);
  assert.equal(expanded.diagnosticDigest, normal.diagnosticDigest);
});

test('accepted-state capsule contains identity/checkpoint/validation but never a raw transcript field', () => {
  const capsule = buildAcceptedStateCapsule({
    taskIdentity: task,
    completed: ['edited file'],
    validation: [{ target: 'unit', status: 'pass' }],
    unresolvedReview: [{ id: 'r1', body: 'bounded finding' }],
    checkpoint: { headSha: 'abc' },
    nextGoal: 'finish correction',
  });
  assert.equal(capsule.identity.issueNumber, 320);
  assert.equal(capsule.checkpoint.headSha, 'abc');
  assert.equal('transcript' in capsule, false);
  assert.match(capsule.fingerprint, /^sha256:/);
});

test('same-PR continuation sends only changed review/validation evidence plus stable identity deltas', () => {
  const previous = {
    headSha: 'a',
    sourceFingerprint: 's1',
    authorityRevision: 'AR-1',
    reviewFindings: [{ id: 'r1', body: 'old' }],
    validation: [{ id: 'v1', status: 'pass' }],
  };
  const current = {
    headSha: 'b',
    sourceFingerprint: 's2',
    authorityRevision: 'AR-1',
    reviewFindings: [{ id: 'r1', body: 'old' }, { id: 'r2', body: 'new' }],
    validation: [{ id: 'v1', status: 'pass' }, { id: 'v2', status: 'failed' }],
  };
  const delta = buildContinuationDelta({ previous, current });
  assert.equal(delta.headSha, 'b');
  assert.equal(delta.sourceFingerprint, 's2');
  assert.equal('authorityRevision' in delta, false);
  assert.deepEqual(delta.reviewFindings.map((item) => item.id), ['r2']);
  assert.deepEqual(delta.validation.map((item) => item.id), ['v2']);
  assert.equal(delta.changed, true);
});

test('deterministic acceptance success stops provider without a narration turn', () => {
  const stop = shouldStopProvider({ implementationComplete: true, deterministicAcceptanceGreen: true });
  assert.deepEqual(stop, { stop: true, preserveCheckpoint: false, reason: 'accepted-provider-phase-complete' });
  const correction = shouldStopProvider({ implementationComplete: true, deterministicAcceptanceGreen: false, unresolvedReasoningBlocker: true });
  assert.equal(correction.stop, false);
  assert.equal(correction.reason, 'reasoning-correction-required');
});

test('turn ceiling stops the loop and preserves recoverable state', () => {
  assert.deepEqual(shouldStopProvider({ turnCeilingReached: true }), {
    stop: true,
    preserveCheckpoint: true,
    reason: 'turn-ceiling-reached',
  });
});

test('bounded telemetry records decisions and measured usage without invented savings', () => {
  const lifecycle = decideSessionLifecycle({ taskIdentity: task, session: null, provider });
  const budget = chooseContextBudget({ taskClass: 'narrow' });
  const capsule = buildBoundedContextCapsule({
    budget,
    sections: [
      { kind: 'authority', value: 'AR', required: true },
      { kind: 'task', value: '#320', required: true },
      { kind: 'source', value: 'sha', required: true },
    ],
  });
  const telemetry = contextBudgetTelemetry({
    lifecycle,
    budget,
    capsule,
    usage: { inputTokens: 100, outputTokens: 20, turnCount: 4 },
    deterministic: { evidenceReused: 2, providerInvocationAvoided: false },
  });
  assert.equal(telemetry.inputTokens, 100);
  assert.equal(telemetry.outputTokens, 20);
  assert.equal(telemetry.deterministicEvidenceReused, 2);
  assert.equal('approximateTokenSaving' in telemetry, false);
});
