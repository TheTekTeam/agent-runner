import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyFalseBlockRestorationPlan,
  evaluateFalseBlockRestoration,
} from './agent-runner-false-block-restoration.mjs';

function classification(overrides = {}) {
  return {
    classification: 'machine_profile_false_block',
    restorableCandidate: true,
    issueNumber: 300,
    incidentRecordId: 'TheTekTeam/modelspend#300:2026-07-20T17:00:00.000Z',
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    number: 300,
    state: 'OPEN',
    body: 'Implementation task with no dependency marker.',
    labels: [{ name: 'status:blocked' }, { name: 'agent:claude-code-cli' }, { name: 'priority:P0' }],
    ...overrides,
  };
}

test('restores only a proven false block with truthful current state', () => {
  const result = evaluateFalseBlockRestoration({ classification: classification(), issue: issue(), linkedOpenPullRequests: [] });
  assert.equal(result.restorable, true);
  assert.equal(result.fromStatus, 'status:blocked');
  assert.equal(result.toStatus, 'status:ready');
});

test('withholds an issue carrying an explicit dependency marker', () => {
  const result = evaluateFalseBlockRestoration({
    classification: classification(),
    issue: issue({ body: 'Blocked by: #299' }),
    linkedOpenPullRequests: [],
  });
  assert.equal(result.restorable, false);
  assert.equal(result.reason, 'explicit-dependency-marker-present');
});

test('withholds a candidate with a linked open pull request', () => {
  const result = evaluateFalseBlockRestoration({
    classification: classification(),
    issue: issue(),
    linkedOpenPullRequests: [{ number: 42 }],
  });
  assert.equal(result.restorable, false);
  assert.equal(result.reason, 'linked-open-pull-request');
});

test('withholds ambiguous current status or agent labels', () => {
  const duplicateStatus = evaluateFalseBlockRestoration({
    classification: classification(),
    issue: issue({ labels: [{ name: 'status:blocked' }, { name: 'status:ready' }, { name: 'agent:claude-code-cli' }] }),
    linkedOpenPullRequests: [],
  });
  assert.equal(duplicateStatus.reason, 'current-status-not-uniquely-blocked');

  const duplicateAgent = evaluateFalseBlockRestoration({
    classification: classification(),
    issue: issue({ labels: [{ name: 'status:blocked' }, { name: 'agent:claude-code-cli' }, { name: 'agent:codex-cli' }] }),
    linkedOpenPullRequests: [],
  });
  assert.equal(duplicateAgent.reason, 'agent-label-not-unique');
});

test('apply mutates only status labels, verifies, then writes one audit event', () => {
  const calls = [];
  const events = [];
  const ghRunner = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    if (args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({
        number: 300,
        state: 'OPEN',
        labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'priority:P0' }],
      });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const store = { recordQueueEvent: (event) => events.push(event) };
  const plan = {
    proposals: [{
      issueNumber: 300,
      incidentRecordId: classification().incidentRecordId,
      restorable: true,
      reason: 'proven-machine-profile-false-block',
      fromStatus: 'status:blocked',
      toStatus: 'status:ready',
    }],
  };
  const report = applyFalseBlockRestorationPlan(store, plan, {
    repo: 'TheTekTeam/modelspend',
    ghRunner,
    now: () => '2026-07-21T01:00:00.000Z',
  });
  assert.equal(report.applied, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'queue-drain-false-block-restored');
  assert.deepEqual(calls[0], [
    'issue', 'edit', '300', '--repo', 'TheTekTeam/modelspend',
    '--remove-label', 'status:blocked', '--add-label', 'status:ready',
  ]);
});

test('dry-run plan entries are never mutated by apply when withheld', () => {
  let called = false;
  const report = applyFalseBlockRestorationPlan({ recordQueueEvent() {} }, {
    proposals: [{ issueNumber: 300, restorable: false, reason: 'linked-open-pull-request' }],
  }, {
    repo: 'TheTekTeam/modelspend',
    ghRunner: () => { called = true; return ''; },
  });
  assert.equal(report.applied, 0);
  assert.equal(called, false);
});
