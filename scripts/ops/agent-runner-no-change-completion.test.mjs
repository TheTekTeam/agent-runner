import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateManagerAuthorizedNoChange,
  parseNoChangeCompletionPolicy,
} from './agent-runner-no-change-completion.mjs';
import { main as pinnedChildMain } from './agent-runner-pinned-child.mjs';

const preflightRevision = 'github-comment:database:5059000001';
const expectedBranch = 'worktree-agent-runner-686-github-comment-database-5059000001';
const baseHead = 'fb83e1c8ec6a918c100f0278a4aacc67f89560a9';

function authority() {
  return {
    allowed: true,
    issueNumber: 686,
    selectionMode: 'preflight-direct',
    preflightRevision,
    preflightIdentity: { version: 1, databaseId: 5059000001, nodeId: 'IC_TEST_PREFLIGHT' },
    claimRevision: preflightRevision,
    claimIdentity: { version: 1, databaseId: 5059000001, nodeId: 'IC_TEST_PREFLIGHT' },
    attemptId: 'TheTekTeam/modelspend#686:2026-07-23T13:30:00.000Z',
  };
}

function noChangePayload(overrides = {}) {
  const root = {
    head: baseHead,
    branch: 'main',
    dirtyEntryCount: 0,
    statusFingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };
  return {
    executionPhase: 'implementation',
    exitCode: 0,
    signal: null,
    blocked: false,
    spawnError: null,
    executionNoop: false,
    planProduced: false,
    awaitingPlanApproval: false,
    failureReason: 'implementation-no-repository-change',
    implementationPublication: null,
    usageAccounting: {
      accountingAvailable: true,
      subtype: 'success',
      isError: false,
      numTurns: 36,
    },
    worktreeIdentity: {
      name: 'agent-runner-686-github-comment-database-5059000001',
      expectedBranch,
    },
    implementationEvidence: {
      valid: false,
      changed: false,
      committed: false,
      clean: true,
      failureReason: 'implementation-no-repository-change',
      baseRef: 'origin/main',
      baseHead,
      rootBefore: { ...root },
      rootAfter: { ...root },
      worktree: {
        head: baseHead,
        branch: expectedBranch,
        dirtyEntryCount: 0,
        statusFingerprint: root.statusFingerprint,
      },
    },
    logPath: '/tmp/agent-runner-no-change-test.json',
    ...overrides,
  };
}

function managerPreflight({ allowNoChange = true } = {}) {
  return {
    id: 'IC_TEST_PREFLIGHT',
    databaseId: 5059000001,
    author: { login: 'gpcola' },
    createdAt: '2026-07-23T13:29:00Z',
    body: [
      '## Manager preflight packet — explicit no-change acceptance',
      '',
      'Phase: implementation',
      ...(allowNoChange ? ['No-change completion: allowed'] : []),
      'Implementation repository: TheTekTeam/agent-runner',
    ].join('\n'),
  };
}

function pinnedEnv() {
  return {
    AGENT_RUNNER_PINNED_ISSUE: '686',
    AGENT_RUNNER_PINNED_SELECTION_MODE: 'preflight-direct',
    AGENT_RUNNER_PINNED_PREFLIGHT_REVISION: preflightRevision,
    AGENT_RUNNER_PINNED_CLAIM_REVISION: preflightRevision,
    AGENT_RUNNER_PINNED_ATTEMPT_ID: authority().attemptId,
  };
}

test('no-change completion is denied when the manager field is absent', () => {
  assert.deepEqual(parseNoChangeCompletionPolicy('Phase: implementation'), {
    explicit: false,
    allowed: false,
    reason: 'no-change-completion-not-authorized',
    value: null,
  });
});

test('no-change completion requires one exact affirmative manager field', () => {
  assert.equal(parseNoChangeCompletionPolicy('No-change completion: allowed').allowed, true);
  assert.equal(parseNoChangeCompletionPolicy('No-change completion: denied').allowed, false);
  assert.equal(parseNoChangeCompletionPolicy('No-change completion: allowed\nNo-change completion: allowed').reason, 'no-change-completion-field-ambiguous');
});

test('clean unchanged success is still rejected without explicit manager authorization', () => {
  const result = evaluateManagerAuthorizedNoChange({
    payload: noChangePayload(),
    policy: parseNoChangeCompletionPolicy(''),
    authority: authority(),
  });
  assert.equal(result.accepted, false);
  assert.ok(result.failedChecks.includes('managerAuthorization'));
});

test('explicit manager authorization promotes exact clean no-change evidence', () => {
  const result = evaluateManagerAuthorizedNoChange({
    payload: noChangePayload(),
    policy: parseNoChangeCompletionPolicy('No-change completion: allowed'),
    authority: authority(),
  });
  assert.equal(result.accepted, true);
  assert.equal(result.payload.failureReason, null);
  assert.equal(result.payload.implementationEvidence.valid, true);
  assert.equal(result.payload.implementationEvidence.repositoryMutated, false);
  assert.equal(result.payload.implementationEvidence.changedFiles, 0);
  assert.equal(result.payload.implementationEvidence.completionKind, 'no-change');
  assert.equal(result.payload.noChangeCompletion.sourcePreflightRevision, preflightRevision);
});

test('dirty worktree cannot be promoted to no-change success', () => {
  const payload = noChangePayload();
  payload.implementationEvidence.worktree.dirtyEntryCount = 1;
  const result = evaluateManagerAuthorizedNoChange({
    payload,
    policy: parseNoChangeCompletionPolicy('No-change completion: allowed'),
    authority: authority(),
  });
  assert.equal(result.accepted, false);
  assert.ok(result.failedChecks.includes('ownedCleanWorktree'));
});

test('failed agent envelope cannot be promoted to no-change success', () => {
  const payload = noChangePayload({
    usageAccounting: { accountingAvailable: true, subtype: 'error', isError: true },
  });
  const result = evaluateManagerAuthorizedNoChange({
    payload,
    policy: parseNoChangeCompletionPolicy('No-change completion: allowed'),
    authority: authority(),
  });
  assert.equal(result.accepted, false);
  assert.ok(result.failedChecks.includes('successfulAgentEnvelope'));
});

test('pinned child returns zero and emits explicit no-change evidence only when authorized', async () => {
  const output = [];
  const originalLog = console.log;
  console.log = (...values) => output.push(values.join(' '));
  try {
    const exitCode = await pinnedChildMain([], pinnedEnv(), {
      originalFetch: async () => new Response(JSON.stringify([managerPreflight()])),
      childMain: async () => {
        await fetch('https://api.github.com/repos/TheTekTeam/modelspend/issues/686/comments');
        console.log(JSON.stringify(noChangePayload()));
        return 1;
      },
    });
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }

  const payload = JSON.parse(output.at(-1));
  assert.equal(payload.failureReason, null);
  assert.equal(payload.noChangeCompletion.accepted, true);
  assert.equal(payload.implementationEvidence.repositoryMutated, false);
  assert.equal(payload.pinnedExecutionAuthority.preflightRevision, preflightRevision);
});

test('pinned child preserves failure when current preflight does not authorize no-change', async () => {
  const output = [];
  const originalLog = console.log;
  console.log = (...values) => output.push(values.join(' '));
  try {
    const exitCode = await pinnedChildMain([], pinnedEnv(), {
      originalFetch: async () => new Response(JSON.stringify([managerPreflight({ allowNoChange: false })])),
      childMain: async () => {
        await fetch('https://api.github.com/repos/TheTekTeam/modelspend/issues/686/comments');
        console.log(JSON.stringify(noChangePayload()));
        return 1;
      },
    });
    assert.equal(exitCode, 1);
  } finally {
    console.log = originalLog;
  }

  const payload = JSON.parse(output.at(-1));
  assert.equal(payload.failureReason, 'implementation-no-repository-change');
  assert.equal(payload.noChangeCompletion, undefined);
});
