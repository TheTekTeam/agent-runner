import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitLane,
  admitLaneBatch,
  laneCapacityReasons,
  laneCollisionReasons,
  reconcileLaneLeases,
} from './agent-runner-lane-admission.mjs';

function lane(overrides = {}) {
  return {
    laneId: 'agent-runner:101:claude:dell',
    projectId: 'agent-runner',
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 101,
    agentInstanceId: 'claude-code-cli@dev-cluster-dell',
    adapterId: 'claude-code-cli',
    nodeId: 'dev-cluster-dell',
    branch: 'worker/101/claude',
    worktree: 'worktrees/101-claude',
    files: ['src/a.mjs'],
    resources: ['repo:agent-runner'],
    ...overrides,
  };
}

const caps = {
  global: 4,
  defaultPerRepository: 3,
  defaultPerAgent: 2,
  defaultPerNode: 2,
};

test('two different issues on isolated lanes are admitted concurrently', () => {
  const first = lane();
  const second = lane({ laneId: 'agent-runner:102:codex:z790', issueNumber: 102, agentInstanceId: 'codex-cli@dev-cluster-z790', adapterId: 'codex-cli', nodeId: 'dev-cluster-z790', branch: 'worker/102/codex', worktree: 'worktrees/102-codex', files: ['src/b.mjs'], resources: ['repo:agent-runner:b'] });
  assert.equal(admitLane(first, { active: [], caps }).admitted, true);
  assert.equal(admitLane(second, { active: [first], caps }).admitted, true);
});

test('same issue requires explicit distinct partitions and integration order', () => {
  const first = lane({ partitionId: 'backend', integrationOrder: 1, files: ['src/backend.mjs'], resources: ['partition:backend'] });
  const second = lane({ laneId: 'agent-runner:101:codex:z790', agentInstanceId: 'codex-cli@dev-cluster-z790', adapterId: 'codex-cli', nodeId: 'dev-cluster-z790', branch: 'worker/101/codex', worktree: 'worktrees/101-codex', partitionId: 'frontend', integrationOrder: 2, files: ['src/frontend.mjs'], resources: ['partition:frontend'] });
  assert.equal(admitLane(second, { active: [first], caps }).admitted, true);
  const missing = lane({ laneId: 'agent-runner:101:codex:z790', agentInstanceId: 'codex-cli@dev-cluster-z790', adapterId: 'codex-cli', nodeId: 'dev-cluster-z790', branch: 'worker/101/codex', worktree: 'worktrees/101-codex', files: ['src/frontend.mjs'], resources: ['partition:frontend'] });
  assert.ok(laneCollisionReasons(missing, [first]).some((reason) => reason.startsWith('same-issue-partition-missing')));
});

test('same-issue explicit partitions still reject overlapping file/resource ownership', () => {
  const first = lane({ partitionId: 'one', integrationOrder: 1, files: ['src/shared.mjs'], resources: ['db:schema'] });
  const second = lane({ laneId: 'agent-runner:101:codex:z790', agentInstanceId: 'codex-cli@dev-cluster-z790', adapterId: 'codex-cli', nodeId: 'dev-cluster-z790', branch: 'worker/101/codex', worktree: 'worktrees/101-codex', partitionId: 'two', integrationOrder: 2, files: ['src/shared.mjs'], resources: ['db:schema'] });
  const reasons = laneCollisionReasons(second, [first]);
  assert.ok(reasons.some((reason) => reason.startsWith('file-collision')));
  assert.ok(reasons.some((reason) => reason.startsWith('resource-collision')));
});

test('branch and worktree collision fail closed across different issues', () => {
  const first = lane();
  const second = lane({ laneId: 'agent-runner:102:codex:dell', issueNumber: 102, agentInstanceId: 'codex-cli@dev-cluster-dell', adapterId: 'codex-cli', files: ['src/b.mjs'], resources: ['repo:b'] });
  const reasons = laneCollisionReasons(second, [first]);
  assert.ok(reasons.some((reason) => reason.startsWith('branch-collision')));
  assert.ok(reasons.some((reason) => reason.startsWith('worktree-collision')));
});

test('global repository agent-instance and node caps are independently enforced', () => {
  const active = [
    lane({ laneId: 'a1', issueNumber: 1, branch: 'b1', worktree: 'w1', files: ['f1'], resources: ['r1'] }),
    lane({ laneId: 'a2', issueNumber: 2, branch: 'b2', worktree: 'w2', files: ['f2'], resources: ['r2'] }),
  ];
  const candidate = lane({ laneId: 'a3', issueNumber: 3, branch: 'b3', worktree: 'w3', files: ['f3'], resources: ['r3'] });
  assert.deepEqual(laneCapacityReasons(candidate, active, { global: 2, defaultPerRepository: 5, defaultPerAgent: 5, defaultPerNode: 5 }), ['global-cap-full']);
  assert.deepEqual(laneCapacityReasons(candidate, active, { global: 5, defaultPerRepository: 2, defaultPerAgent: 5, defaultPerNode: 5 }), ['repository-cap-full']);
  assert.deepEqual(laneCapacityReasons(candidate, active, { global: 5, defaultPerRepository: 5, defaultPerAgent: 2, defaultPerNode: 5 }), ['agent-cap-full']);
  assert.deepEqual(laneCapacityReasons(candidate, active, { global: 5, defaultPerRepository: 5, defaultPerAgent: 5, defaultPerNode: 2 }), ['node-cap-full']);
});

test('per-adapter cap spans the same adapter across multiple nodes', () => {
  const active = [
    lane({ laneId: 'dell-claude', issueNumber: 1, branch: 'b1', worktree: 'w1', files: ['f1'], resources: ['r1'] }),
    lane({ laneId: 'z790-claude', issueNumber: 2, agentInstanceId: 'claude-code-cli@dev-cluster-z790', nodeId: 'dev-cluster-z790', branch: 'b2', worktree: 'w2', files: ['f2'], resources: ['r2'] }),
  ];
  const candidate = lane({ laneId: 'future-claude', issueNumber: 3, agentInstanceId: 'claude-code-cli@future-worker', nodeId: 'future-worker', branch: 'b3', worktree: 'w3', files: ['f3'], resources: ['r3'] });
  assert.ok(laneCapacityReasons(candidate, active, { global: 5, defaultPerRepository: 5, defaultPerAgent: 5, defaultPerNode: 5, perAgent: { 'claude-code-cli': 2 } }).includes('agent-cap-full'));
});

test('a blocked candidate does not prevent a later unrelated admissible lane', () => {
  const active = [lane({ laneId: 'busy', issueNumber: 1, branch: 'busy', worktree: 'busy', files: ['busy.mjs'], resources: ['busy'] })];
  const conflicting = lane({ laneId: 'conflict', issueNumber: 2, branch: 'busy', worktree: 'new', files: ['other.mjs'], resources: ['other'] });
  const unrelated = lane({ laneId: 'other-repo', projectId: 'other', repository: 'TheTekTeam/other', issueNumber: 7, agentInstanceId: 'codex-cli@dev-cluster-z790', adapterId: 'codex-cli', nodeId: 'dev-cluster-z790', branch: 'other-7', worktree: 'other-7', files: ['src/x.mjs'], resources: ['other-repo'] });
  const result = admitLaneBatch([conflicting, unrelated], { active, caps: { global: 4, defaultPerRepository: 2, defaultPerAgent: 2, defaultPerNode: 2 } });
  assert.deepEqual(result.admitted.map((entry) => entry.laneId), ['other-repo']);
  assert.equal(result.rejected[0].laneId, 'conflict');
});

test('restart reconciliation retains only live unexpired exact lanes and never steals stale work', () => {
  const leases = [lane({ laneId: 'live' }), lane({ laneId: 'dead', issueNumber: 2, branch: 'dead', worktree: 'dead', files: ['dead'], resources: ['dead'] }), lane({ laneId: 'expired', issueNumber: 3, branch: 'expired', worktree: 'expired', files: ['expired'], resources: ['expired'] })];
  const result = reconcileLaneLeases(leases, { liveLaneIds: ['live', 'expired'], now: new Date('2026-08-25T12:00:00Z'), expiryByLane: { live: '2026-08-26T00:00:00Z', expired: '2026-08-25T00:00:00Z' } });
  assert.deepEqual(result.retained.map((entry) => entry.laneId), ['live']);
  assert.deepEqual(result.stale, [{ laneId: 'dead', reason: 'owner-not-live' }, { laneId: 'expired', reason: 'lease-expired' }]);
});
