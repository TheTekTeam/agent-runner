import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNoSelectionPayload, candidateFromSelection } from './claude-runner-candidate-probe.mjs';

test('candidate probe reports no candidate for an empty queue', () => {
  assert.deepEqual(candidateFromSelection({ issue: null, skipped: [] }), {
    candidate: false,
    selectedIssue: null,
    selectionMode: null,
    skipCount: 0,
    candidateSnapshot: null,
  });
});

test('candidate probe recognises an already-runnable selected issue and emits a sanitized handoff snapshot', () => {
  const result = candidateFromSelection({
    issue: {
      number: 711,
      labels: ['status:ready', 'agent:claude-code-cli'],
      statusLabel: 'status:ready',
      agentLabel: 'agent:claude-code-cli',
    },
    selection: { mode: 'preflight-direct' },
    skipped: [],
  });

  assert.equal(result.candidate, true);
  assert.equal(result.selectedIssue, 711);
  assert.equal(result.selectionMode, 'preflight-direct');
  assert.equal(result.skipCount, 0);
  assert.equal(result.candidateSnapshot.issueNumber, 711);
  assert.equal(result.candidateSnapshot.statusLabel, 'status:ready');
  assert.equal(result.candidateSnapshot.agentLabel, 'agent:claude-code-cli');
  assert.equal(result.candidateSnapshot.resolvedAgentId, 'claude-code-cli');
  assert.equal(result.candidateSnapshot.selectionMode, 'preflight-direct');
  assert.equal(Object.prototype.hasOwnProperty.call(result.candidateSnapshot, 'body'), false);
});

test('candidate probe does not treat missing manager authority as locally repairable', () => {
  const result = candidateFromSelection({
    issue: null,
    skipped: [{ issue: 711, reason: 'manager-preflight-required' }],
  });
  assert.equal(result.candidate, false);
  assert.equal(result.candidateSnapshot, null);
});

test('empty-poll payload records no-selection without pretending a quota sample occurred', () => {
  const payload = buildNoSelectionPayload(
    { stateDbPath: '.var/claude-runner/runner-state.sqlite' },
    { skipped: [{ issue: 271, reason: 'preflight-generation-needs-manager' }] },
  );
  assert.equal(payload.selectedIssue, null);
  assert.equal(payload.candidateProbe, true);
  assert.deepEqual(payload.quotaPreflight, {
    blocked: false,
    skipped: true,
    reason: 'no-runnable-issue',
  });
  assert.equal(payload.skipped[0].issue, 271);
});
