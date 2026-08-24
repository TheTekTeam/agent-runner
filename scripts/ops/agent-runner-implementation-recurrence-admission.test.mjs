import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitRecurrenceSelections,
  classifyProbeOutcome,
  laneAdmissionCandidateForSelection,
  resolveLocalWorkerNodeId,
  resolveRecurrenceLaneCaps,
} from './agent-runner-implementation-recurrence.mjs';

function selection({ projectId, repository, issueNumber, agentId = 'claude-code-cli' }) {
  return {
    entry: { config: { projectId, githubRepo: repository } },
    outcome: { runnable: true, selectedIssue: issueNumber, selectedAgentId: agentId },
  };
}

test('legacy probe result shape remains unchanged when no adapter identity is supplied', () => {
  assert.deepEqual(classifyProbeOutcome({ status: 0, payload: { selectedIssue: 42 } }), {
    runnable: true,
    blocked: false,
    reason: 'runnable-candidate',
    selectedIssue: 42,
  });
  assert.deepEqual(classifyProbeOutcome({ status: 0, payload: { selectedIssue: 42, selectedAgentId: 'claude-code-cli' } }), {
    runnable: true,
    blocked: false,
    reason: 'runnable-candidate',
    selectedIssue: 42,
    selectedAgentId: 'claude-code-cli',
  });
});

test('lane caps default to recurrence capacity but fail closed to one unknown-scope lane per repository', () => {
  const caps = resolveRecurrenceLaneCaps({}, 3);
  assert.equal(caps.global, 3);
  assert.equal(caps.defaultPerRepository, 1);
  assert.equal(caps.defaultPerAgent, 3);
  assert.equal(caps.defaultPerNode, 3);
});

test('bounded JSON can narrow per-adapter and per-node capacity', () => {
  const caps = resolveRecurrenceLaneCaps({
    AGENT_RUNNER_LANE_CAPS_JSON: JSON.stringify({
      global: 4,
      defaultPerRepository: 2,
      perAgent: { 'claude-code-cli': 1 },
      perNode: { 'dev-cluster-dell': 2 },
    }),
  }, 4);
  assert.equal(caps.global, 4);
  assert.equal(caps.defaultPerRepository, 2);
  assert.equal(caps.perAgent['claude-code-cli'], 1);
  assert.equal(caps.perNode['dev-cluster-dell'], 2);
  assert.throws(() => resolveRecurrenceLaneCaps({ AGENT_RUNNER_LANE_CAPS_JSON: '{bad' }, 2), /valid JSON/);
});

test('local recurrence preserves Dell worker identity until generic node routing positively selects another worker', () => {
  assert.equal(resolveLocalWorkerNodeId({}), 'dev-cluster-dell');
  const candidate = laneAdmissionCandidateForSelection(
    { config: { projectId: 'agent-runner', githubRepo: 'TheTekTeam/agent-runner' } },
    { selectedIssue: 327, selectedAgentId: 'claude-code-cli' },
  );
  assert.equal(candidate.agentInstanceId, 'claude-code-cli@dev-cluster-dell');
  assert.equal(candidate.nodeId, 'dev-cluster-dell');
});

test('different repositories may consume independent recurrence lanes up to global capacity', () => {
  const selected = [
    selection({ projectId: 'agent-runner', repository: 'TheTekTeam/agent-runner', issueNumber: 327 }),
    selection({ projectId: 'modelspend', repository: 'TheTekTeam/modelspend', issueNumber: 900 }),
  ];
  const result = admitRecurrenceSelections(selected, {
    env: { AGENT_RUNNER_MAX_PARALLEL: '2' },
    maxParallel: 2,
  });
  assert.deepEqual(result.admission.admitted.map((lane) => lane.laneId), [
    'agent-runner:issue:327',
    'modelspend:issue:900',
  ]);
  assert.equal(result.admittedSelections.length, 2);
});

test('same repository unknown-scope candidate is rejected without blocking unrelated capacity', () => {
  const selected = [
    selection({ projectId: 'first', repository: 'TheTekTeam/shared', issueNumber: 1 }),
    selection({ projectId: 'second', repository: 'TheTekTeam/shared', issueNumber: 2 }),
    selection({ projectId: 'third', repository: 'TheTekTeam/other', issueNumber: 3 }),
  ];
  const result = admitRecurrenceSelections(selected, { env: {}, maxParallel: 3 });
  assert.deepEqual(result.admission.admitted.map((lane) => lane.laneId), ['first:issue:1', 'third:issue:3']);
  assert.equal(result.admission.rejected[0].laneId, 'second:issue:2');
  assert.ok(result.admission.rejected[0].reasons.includes('repository-cap-full'));
});

test('adapter-wide cap applies to concurrent local lanes across projects', () => {
  const selected = [
    selection({ projectId: 'one', repository: 'Owner/one', issueNumber: 1 }),
    selection({ projectId: 'two', repository: 'Owner/two', issueNumber: 2 }),
  ];
  const result = admitRecurrenceSelections(selected, {
    env: { AGENT_RUNNER_LANE_CAPS_JSON: JSON.stringify({ perAgent: { 'claude-code-cli': 1 } }) },
    maxParallel: 2,
  });
  assert.deepEqual(result.admission.admitted.map((lane) => lane.laneId), ['one:issue:1']);
  assert.ok(result.admission.rejected[0].reasons.includes('agent-cap-full'));
});
