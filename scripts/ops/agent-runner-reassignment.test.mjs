import assert from 'node:assert/strict';
import test from 'node:test';

import { isManagerPreflightRevocation, MANAGER_PREFLIGHT_MARKER } from './agent-runner-manager-authority.mjs';
import {
  applyPlannedReassignment,
  buildNoQualifiedAgentEvidenceCommentBody,
  buildReassignmentEvidenceCommentBody,
  evaluateReassignmentPreconditions,
  noQualifiedAgentDedupeKey,
  planLabelMutation,
  planReassignment,
  reassignmentDedupeKey,
  resolveReplacementAgentLabel,
  ROUTING_ATTENTION_MARKER,
  statusLabelUnchanged,
  verifyLabelMutation,
} from './agent-runner-reassignment.mjs';

function allAbsentGuards(overrides = {}) {
  return {
    hasActiveLease: false,
    hasUnfinishedAttempt: false,
    hasInProgressOwnership: false,
    hasLinkedOpenPullRequest: false,
    hasReviewOrRecoveryState: false,
    hasHandoffInProgress: false,
    hasConflictingBranchOrWorktree: false,
    hasUnresolvedWorkspaceOwnership: false,
    ...overrides,
  };
}

function readyIssue(labels = ['status:ready', 'agent:claude-code-cli']) {
  return { number: 50, statusLabel: 'status:ready', labels: labels.map((name) => ({ name })) };
}

// -- evaluateReassignmentPreconditions: the full precondition proof --

test('a fully-proven queued, unclaimed issue with a stable settings revision and stable labels is allowed', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    liveLabelsAtPlanning: readyIssue().labels,
    liveLabelsNow: readyIssue().labels,
    ...allAbsentGuards(),
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.blockers, []);
});

test('an issue not in status:ready is blocked', () => {
  const result = evaluateReassignmentPreconditions({
    issue: { number: 50, statusLabel: 'status:in-progress' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards(),
  });
  assert.ok(result.blockers.includes('not-queued-ready'));
});

test('an active lease blocks reassignment', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasActiveLease: true }),
  });
  assert.ok(result.blockers.includes('active-lease'));
});

test('status:in-progress ownership blocks reassignment', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasInProgressOwnership: true }),
  });
  assert.ok(result.blockers.includes('in-progress-ownership'));
});

test('a linked open pull request blocks reassignment', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasLinkedOpenPullRequest: true }),
  });
  assert.ok(result.blockers.includes('linked-open-pull-request'));
});

test('review/handoff or preserved recovery state blocks reassignment', () => {
  const reviewResult = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasReviewOrRecoveryState: true }),
  });
  assert.ok(reviewResult.blockers.includes('review-or-recovery-state'));

  const handoffResult = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasHandoffInProgress: true }),
  });
  assert.ok(handoffResult.blockers.includes('handoff-in-progress'));
});

test('a conflicting branch/worktree blocks reassignment', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasConflictingBranchOrWorktree: true }),
  });
  assert.ok(result.blockers.includes('conflicting-branch-or-worktree'));
});

test('an unfinished attempt blocks reassignment', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasUnfinishedAttempt: true }),
  });
  assert.ok(result.blockers.includes('unfinished-attempt'));
});

test('unresolved workspace ownership blocks reassignment', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasUnresolvedWorkspaceOwnership: true }),
  });
  assert.ok(result.blockers.includes('unresolved-workspace-ownership'));
});

test('a settings revision change since planning blocks reassignment', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:bbb',
    ...allAbsentGuards(),
  });
  assert.ok(result.blockers.includes('settings-revision-changed'));
});

test('a live issue label change since the planning read blocks reassignment', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    liveLabelsAtPlanning: readyIssue().labels,
    liveLabelsNow: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'priority:P0' }],
    ...allAbsentGuards(),
  });
  assert.ok(result.blockers.includes('live-labels-changed'));
});

test('any ambiguous (undefined/null/true) guard fails closed without mutation, even when only one guard is ambiguous', () => {
  const undefinedGuard = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasActiveLease: undefined }),
  });
  assert.ok(undefinedGuard.blockers.includes('active-lease'));

  const nullGuard = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards({ hasLinkedOpenPullRequest: null }),
  });
  assert.ok(nullGuard.blockers.includes('linked-open-pull-request'));
});

test('a missing settings revision on either side fails closed', () => {
  const result = evaluateReassignmentPreconditions({
    issue: readyIssue(),
    settingsRevisionAtPlanning: null,
    settingsRevisionNow: 'sha256:aaa',
    ...allAbsentGuards(),
  });
  assert.ok(result.blockers.includes('settings-revision-changed'));
});

// -- label mutation planning + verification --

test('resolveReplacementAgentLabel prefers the exact agent:<id> label when one exists', () => {
  assert.equal(resolveReplacementAgentLabel('claude-code-cli'), 'agent:claude-code-cli');
  assert.equal(resolveReplacementAgentLabel('codex-cli'), 'agent:codex-cli');
  assert.equal(resolveReplacementAgentLabel('grok-cli'), 'agent:grok-cli');
});

test('resolveReplacementAgentLabel falls back to the adapter\'s sole label when no agent:<id> form exists (ollama-agent -> agent:ollama)', () => {
  assert.equal(resolveReplacementAgentLabel('ollama-agent'), 'agent:ollama');
});

test('planLabelMutation removes every supported agent label and preserves unrelated labels', () => {
  const plan = planLabelMutation({
    currentLabels: ['status:ready', 'priority:P0', 'agent:claude', 'agent:claude-code-cli'],
    replacementAgentLabel: 'agent:ollama',
  });
  assert.deepEqual(plan.removeLabels.sort(), ['agent:claude', 'agent:claude-code-cli']);
  assert.deepEqual(plan.addLabels, ['agent:ollama']);
  assert.deepEqual(plan.expectedFinalLabels, ['agent:ollama', 'priority:P0', 'status:ready']);
});

test('verifyLabelMutation passes only when exactly one supported agent label remains and it is the replacement, and unrelated labels survive', () => {
  const plan = planLabelMutation({ currentLabels: ['status:ready', 'priority:P0', 'agent:claude-code-cli'], replacementAgentLabel: 'agent:ollama' });
  const ok = verifyLabelMutation({
    liveLabelsAfter: [{ name: 'status:ready' }, { name: 'priority:P0' }, { name: 'agent:ollama' }],
    expectedFinalLabels: plan.expectedFinalLabels,
    replacementAgentLabel: plan.replacementAgentLabel,
  });
  assert.equal(ok.ok, true);
});

test('verifyLabelMutation fails a post-mutation label mismatch (stale agent label left behind)', () => {
  const plan = planLabelMutation({ currentLabels: ['status:ready', 'agent:claude-code-cli'], replacementAgentLabel: 'agent:ollama' });
  const result = verifyLabelMutation({
    liveLabelsAfter: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'agent:ollama' }],
    expectedFinalLabels: plan.expectedFinalLabels,
    replacementAgentLabel: plan.replacementAgentLabel,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'post-mutation-label-mismatch');
});

test('verifyLabelMutation fails when the replacement label is simply missing after mutation', () => {
  const plan = planLabelMutation({ currentLabels: ['status:ready', 'agent:claude-code-cli'], replacementAgentLabel: 'agent:ollama' });
  const result = verifyLabelMutation({
    liveLabelsAfter: [{ name: 'status:ready' }],
    expectedFinalLabels: plan.expectedFinalLabels,
    replacementAgentLabel: plan.replacementAgentLabel,
  });
  assert.equal(result.ok, false);
});

test('statusLabelUnchanged proves the status label is never part of a reassignment mutation', () => {
  assert.equal(statusLabelUnchanged({ statusLabelBefore: 'status:ready', statusLabelAfter: 'status:ready' }), true);
  assert.equal(statusLabelUnchanged({ statusLabelBefore: 'status:ready', statusLabelAfter: 'status:in-progress' }), false);
});

// -- evidence comment bodies never collide with manager preflight authority --

test('the routing-attention marker is distinct from the manager preflight marker', () => {
  assert.notEqual(ROUTING_ATTENTION_MARKER, MANAGER_PREFLIGHT_MARKER);
});

test('the reassignment evidence comment body never contains the manager preflight marker and is never parsed as a revocation', () => {
  const body = buildReassignmentEvidenceCommentBody({ issueNumber: 50, fromAgentId: 'claude-code-cli', toAgentId: 'ollama-agent', reason: 'agent-disabled', settingsRevision: 'sha256:aaa' });
  assert.ok(body.includes(ROUTING_ATTENTION_MARKER));
  assert.ok(!body.includes(MANAGER_PREFLIGHT_MARKER));
  assert.equal(isManagerPreflightRevocation(body), false);
});

test('the no-qualified-agent evidence comment body never contains the manager preflight marker and is never parsed as a revocation', () => {
  const body = buildNoQualifiedAgentEvidenceCommentBody({ issueNumber: 50, settingsRevision: 'sha256:aaa' });
  assert.ok(body.includes(ROUTING_ATTENTION_MARKER));
  assert.ok(!body.includes(MANAGER_PREFLIGHT_MARKER));
  assert.equal(isManagerPreflightRevocation(body), false);
});

test('evidence comment bodies never contain raw settings, secretref, credential, executable path, endpoint, prompt, or provider text', () => {
  const body = buildReassignmentEvidenceCommentBody({ issueNumber: 50, fromAgentId: 'claude-code-cli', toAgentId: 'ollama-agent', reason: 'agent-disabled', settingsRevision: 'sha256:aaa' });
  assert.doesNotMatch(body, /executablePath|sessionSecretRef|http:\/\/|https:\/\/|vault:\/\//);
});

// -- dedupe keys --

test('reassignmentDedupeKey and noQualifiedAgentDedupeKey are stable and distinguishable by issue/agent/revision', () => {
  const a = reassignmentDedupeKey({ repo: 'TheTekTeam/agent-runner', issueNumber: 50, fromAgentId: 'claude-code-cli', toAgentId: 'ollama-agent', settingsRevision: 'sha256:aaa' });
  const b = reassignmentDedupeKey({ repo: 'TheTekTeam/agent-runner', issueNumber: 50, fromAgentId: 'claude-code-cli', toAgentId: 'ollama-agent', settingsRevision: 'sha256:aaa' });
  const c = reassignmentDedupeKey({ repo: 'TheTekTeam/agent-runner', issueNumber: 50, fromAgentId: 'claude-code-cli', toAgentId: 'ollama-agent', settingsRevision: 'sha256:bbb' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, noQualifiedAgentDedupeKey({ repo: 'TheTekTeam/agent-runner', issueNumber: 50, settingsRevision: 'sha256:aaa' }));
});

// -- planReassignment: full orchestration --

test('planReassignment is disallowed when preconditions fail, before consulting the routing selection', () => {
  const plan = planReassignment({
    issue: { number: 50, statusLabel: 'status:in-progress' },
    currentLabels: readyIssue().labels,
    explicitAgentId: 'claude-code-cli',
    routingSelection: { selectedAgentId: 'ollama-agent' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    repo: 'TheTekTeam/agent-runner',
    ...allAbsentGuards(),
  });
  assert.equal(plan.allowed, false);
  assert.ok(plan.blockers.includes('not-queued-ready'));
});

test('planReassignment is disallowed when the routing selection has no alternative (selection equals the explicit agent, or none)', () => {
  const plan = planReassignment({
    issue: readyIssue(),
    currentLabels: readyIssue().labels,
    explicitAgentId: 'claude-code-cli',
    routingSelection: { selectedAgentId: 'claude-code-cli' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    repo: 'TheTekTeam/agent-runner',
    ...allAbsentGuards(),
  });
  assert.equal(plan.allowed, false);
  assert.ok(plan.blockers.includes('no-reassignment-candidate'));
});

test('planReassignment produces a full label-mutation plan and evidence body when everything is proven and an alternative is eligible', () => {
  const plan = planReassignment({
    issue: readyIssue(),
    currentLabels: readyIssue().labels,
    explicitAgentId: 'claude-code-cli',
    routingSelection: { selectedAgentId: 'ollama-agent' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    repo: 'TheTekTeam/agent-runner',
    ...allAbsentGuards(),
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.replacementAgentId, 'ollama-agent');
  assert.deepEqual(plan.labelMutation.removeLabels, ['agent:claude-code-cli']);
  assert.deepEqual(plan.labelMutation.addLabels, ['agent:ollama']);
  assert.ok(plan.evidenceCommentBody.includes(ROUTING_ATTENTION_MARKER));
  assert.ok(plan.dedupeKey);
});

// -- applyPlannedReassignment: injected IO --

test('applyPlannedReassignment never calls mutateLabels when the plan is not allowed', () => {
  let calls = 0;
  const result = applyPlannedReassignment({
    plan: { allowed: false, blockers: ['active-lease'] },
    mutateLabels: () => { calls += 1; },
    readLiveIssue: () => { calls += 1; return {}; },
  });
  assert.equal(calls, 0);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'plan-not-allowed');
});

test('applyPlannedReassignment reports a GitHub mutation failure without treating it as success', () => {
  const plan = planReassignment({
    issue: readyIssue(),
    currentLabels: readyIssue().labels,
    explicitAgentId: 'claude-code-cli',
    routingSelection: { selectedAgentId: 'ollama-agent' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    repo: 'TheTekTeam/agent-runner',
    ...allAbsentGuards(),
  });
  const result = applyPlannedReassignment({
    plan,
    mutateLabels: () => { throw new Error('gh issue edit failed'); },
    readLiveIssue: () => ({ labels: [] }),
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'github-mutation-failed');
});

test('applyPlannedReassignment reports unavailable post-mutation verification (readLiveIssue returns nothing) rather than assuming success', () => {
  const plan = planReassignment({
    issue: readyIssue(),
    currentLabels: readyIssue().labels,
    explicitAgentId: 'claude-code-cli',
    routingSelection: { selectedAgentId: 'ollama-agent' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    repo: 'TheTekTeam/agent-runner',
    ...allAbsentGuards(),
  });
  const result = applyPlannedReassignment({
    plan,
    mutateLabels: () => {},
    readLiveIssue: () => null,
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'post-mutation-verification-unavailable');
});

test('applyPlannedReassignment reports a post-mutation label mismatch rather than treating a clean gh exit as success', () => {
  const plan = planReassignment({
    issue: readyIssue(),
    currentLabels: readyIssue().labels,
    explicitAgentId: 'claude-code-cli',
    routingSelection: { selectedAgentId: 'ollama-agent' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    repo: 'TheTekTeam/agent-runner',
    ...allAbsentGuards(),
  });
  const result = applyPlannedReassignment({
    plan,
    mutateLabels: () => {},
    readLiveIssue: () => ({ labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'agent:ollama' }] }),
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'post-mutation-label-mismatch');
});

test('applyPlannedReassignment reports success only when the full plan applies and post-mutation verification proves exactly one replacement label', () => {
  const plan = planReassignment({
    issue: readyIssue(),
    currentLabels: readyIssue().labels,
    explicitAgentId: 'claude-code-cli',
    routingSelection: { selectedAgentId: 'ollama-agent' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    repo: 'TheTekTeam/agent-runner',
    ...allAbsentGuards(),
  });
  const result = applyPlannedReassignment({
    plan,
    mutateLabels: () => {},
    readLiveIssue: () => ({ labels: [{ name: 'status:ready' }, { name: 'agent:ollama' }] }),
  });
  assert.equal(result.applied, true);
  assert.equal(result.verification.ok, true);
});

// -- issue #50 review, sink hardening: mutation/read failures return fixed reason codes, never the raw exception message --

test('applyPlannedReassignment never echoes a raw mutateLabels exception message -- a token, path, or provider fragment in the underlying gh error must never reach the result', () => {
  const plan = planReassignment({
    issue: readyIssue(),
    currentLabels: readyIssue().labels,
    explicitAgentId: 'claude-code-cli',
    routingSelection: { selectedAgentId: 'ollama-agent' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    repo: 'TheTekTeam/agent-runner',
    ...allAbsentGuards(),
  });
  const result = applyPlannedReassignment({
    plan,
    // Deliberately under the secret-scanner's 20-char threshold (this repo's
    // own scripts/validate.sh flags any real-shaped ghp_ token, even in a
    // test fixture) -- short enough to be obviously synthetic, still real
    // enough in shape to prove the redaction, matching the style already
    // used by agent-runner-supervised-canary.test.mjs.
    mutateLabels: () => { throw new Error('gh: authentication failed for token ghp_abcdefghijklmnop against https://api.github.com/repos/x/y/issues/1'); },
    readLiveIssue: () => ({ labels: [] }),
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'github-mutation-failed');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('ghp_abcdefghijklmnop'));
  assert.ok(!serialized.includes('api.github.com'));
  assert.deepEqual(Object.keys(result).sort(), ['applied', 'reason']);
});

test('applyPlannedReassignment never echoes a raw readLiveIssue exception message either', () => {
  const plan = planReassignment({
    issue: readyIssue(),
    currentLabels: readyIssue().labels,
    explicitAgentId: 'claude-code-cli',
    routingSelection: { selectedAgentId: 'ollama-agent' },
    settingsRevisionAtPlanning: 'sha256:aaa',
    settingsRevisionNow: 'sha256:aaa',
    repo: 'TheTekTeam/agent-runner',
    ...allAbsentGuards(),
  });
  const result = applyPlannedReassignment({
    plan,
    mutateLabels: () => {},
    readLiveIssue: () => { throw new Error('gh: rate limited, session=sk-live-SyntheticSecretShouldNeverLeak'); },
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'post-mutation-read-failed');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('sk-live-SyntheticSecretShouldNeverLeak'));
  assert.deepEqual(Object.keys(result).sort(), ['applied', 'reason']);
});
