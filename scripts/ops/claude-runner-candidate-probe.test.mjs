import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNoSelectionPayload, candidateFromSelection } from './claude-runner-candidate-probe.mjs';

test('candidate probe reports no candidate for an empty queue', () => {
  assert.deepEqual(candidateFromSelection({ issue: null, skipped: [] }), {
    candidate: false,
    selectedIssue: null,
    selectionMode: null,
    sourcePreflightCommentId: null,
    pendingAutoPreflight: false,
    skipCount: 0,
  });
});

test('candidate probe reports the exact selected manager-preflight identity', () => {
  assert.deepEqual(candidateFromSelection({
    issue: { number: 711 },
    currentPreflight: { id: 5057357402 },
    selection: { mode: 'preflight-direct', preflight: { id: 5057357402 } },
    skipped: [],
  }), {
    candidate: true,
    selectedIssue: 711,
    selectionMode: 'preflight-direct',
    sourcePreflightCommentId: 'github-comment:database:5057357402',
    pendingAutoPreflight: false,
    skipCount: 0,
  });
});

test('candidate probe recognises a safe auto-preflight candidate without mutating GitHub', () => {
  const result = candidateFromSelection({
    issue: null,
    skipped: [{ issue: 711, reason: 'preflight-generation-pending-dry-run' }],
  });
  assert.equal(result.candidate, true);
  assert.equal(result.pendingAutoPreflight, true);
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
