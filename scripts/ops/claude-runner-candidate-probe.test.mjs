import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNoSelectionPayload, candidateFromSelection } from './claude-runner-candidate-probe.mjs';

test('candidate probe reports no candidate for an empty queue without changing the legacy payload shape', () => {
  assert.deepEqual(candidateFromSelection({ issue: null, skipped: [] }), {
    candidate: false,
    selectedIssue: null,
    selectionMode: null,
    skipCount: 0,
  });
});

test('candidate probe recognises an already-runnable unlabelled issue without changing the legacy payload shape', () => {
  assert.deepEqual(candidateFromSelection({
    issue: { number: 711 },
    selection: { mode: 'preflight-direct' },
    skipped: [],
  }), {
    candidate: true,
    selectedIssue: 711,
    selectionMode: 'preflight-direct',
    skipCount: 0,
  });
});

test('candidate probe adds exact adapter identity only when an assignment label resolves it', () => {
  assert.deepEqual(candidateFromSelection({
    issue: { number: 712, labels: [{ name: 'agent:codex-claude' }] },
    selection: { mode: 'preflight-direct' },
    skipped: [],
  }), {
    candidate: true,
    selectedIssue: 712,
    selectedAgentId: 'claude-code-cli',
    selectionMode: 'preflight-direct',
    skipCount: 0,
  });
});

test('candidate probe does not treat missing manager authority as locally repairable', () => {
  const result = candidateFromSelection({
    issue: null,
    skipped: [{ issue: 711, reason: 'manager-preflight-required' }],
  });
  assert.equal(result.candidate, false);
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
