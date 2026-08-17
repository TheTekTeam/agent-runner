import assert from 'node:assert/strict';
import test from 'node:test';

import { parseManagerPreflightPacket } from './agent-runner-manager-authority.mjs';
import { resolvePrContinuationBinding } from './agent-runner-pr-continuation-binding.mjs';

const REPO = 'TheTekTeam/agent-runner';
const BRANCH = 'claude/pr-continuation-fixture-241';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FINGERPRINT = `sha256:${'c'.repeat(64)}`;

function managerPacket({ id = 1, revision = 'AR241.1' } = {}) {
  return {
    id,
    createdAt: '2026-08-17T19:00:00Z',
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: ${revision}\nfingerprint: ${FINGERPRINT}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nprofile: complex\nmodel: sonnet\neffort: medium\nmax_budget_usd: "2.00"\napproved_repository_scope:\n  - ${REPO}\napproved_branch: ${BRANCH}\nbase_commit: ${BASE}\nscope:\n  - bounded continuation binding fixture\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\``,
  };
}

function claim(packet, id = 2) {
  const authority = parseManagerPreflightPacket(packet);
  return {
    id,
    createdAt: '2026-08-17T19:01:00Z',
    body: `## Claude runner started\n\n- Manager packet revision: ${authority.revision}\n- Manager packet fingerprint: ${authority.fingerprint}\n- Manager packet authority: ${authority.authorityKey}`,
  };
}

function fixture(overrides = {}) {
  const packet = managerPacket();
  const calls = { dispatch: 0, workspace: 0, evidence: 0 };
  const pullRequest = {
    number: 99,
    state: 'open',
    title: 'PR continuation fixture',
    body: 'Fixes #241',
    head: { repo: { full_name: REPO }, ref: BRANCH, sha: HEAD },
    ...overrides.pullRequest,
  };
  const issue = { number: 241, title: 'fixture issue', ...overrides.issue };
  const dispatchIdentity = {
    ok: true,
    profileName: 'complex',
    managerExecutionMeta: {
      profile: 'complex',
      model: 'sonnet',
      effort: 'medium',
      maxBudgetUsd: { present: true, valid: true, value: 2, raw: '2.00' },
    },
    executionAuthorization: { allowed: true, phase: 'implementation', permissionMode: 'dontAsk' },
    repositoryContext: { implementationRepository: REPO, implementationCheckout: '/repo' },
    dispatchAuthority: { repository: REPO, branch: BRANCH, baseCommit: BASE },
    worktreeIdentity: { name: 'pr-continuation-fixture-241', expectedBranch: BRANCH },
    ...overrides.dispatchIdentity,
  };
  const workspace = {
    allowed: true,
    failureReason: null,
    baseRef: 'origin/main',
    baseHead: HEAD,
    rootPath: '/repo',
    worktreePath: '/repo/.claude/worktrees/pr-continuation-fixture-241',
    workspacePreparedByRunner: true,
    ...overrides.workspace,
  };
  const evidence = {
    head: HEAD,
    branch: BRANCH,
    dirtyEntryCount: 0,
    statusFingerprint: 'sha256:clean',
    ...overrides.evidence,
  };

  return {
    calls,
    args: {
      pullRequest,
      issue,
      issueComments: overrides.issueComments || [packet, claim(packet)],
      repo: REPO,
      config: { githubRepo: REPO, localRepoPath: '/repo' },
      env: { CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true' },
      runner: () => { throw new Error('fixture runner should be consumed only by injected workspace/evidence helpers'); },
      resolveDispatchIdentity: (input) => {
        calls.dispatch += 1;
        assert.equal(input.issue.number, issue.number);
        assert.equal(input.argsRepo, REPO);
        assert.match(input.currentPreflight.body, /agent-runner:manager-preflight/);
        return dispatchIdentity;
      },
      prepareWorkspace: (input) => {
        calls.workspace += 1;
        assert.equal(input.worktreeIdentity.expectedBranch, BRANCH);
        assert.equal(input.implementationCheckout, '/repo');
        return workspace;
      },
      captureEvidence: (input) => {
        calls.evidence += 1;
        assert.equal(input.cwd, workspace.worktreePath);
        assert.equal(input.includeUntracked, true);
        return evidence;
      },
    },
  };
}

function resolve(overrides = {}) {
  const built = fixture(overrides);
  return { ...built, result: resolvePrContinuationBinding(built.args) };
}

test('binds a claimed current manager packet to the exact authorised clean PR worktree', () => {
  const { result, calls } = resolve();
  assert.equal(result.allowed, true);
  assert.equal(result.issueNumber, 241);
  assert.equal(result.prNumber, 99);
  assert.equal(result.repository, REPO);
  assert.equal(result.branch, BRANCH);
  assert.equal(result.preRunHeadSha, HEAD);
  assert.equal(result.authority.alreadyClaimed, true);
  assert.equal(result.workspace.baseHead, HEAD);
  assert.equal(result.worktreeEvidence.dirtyEntryCount, 0);
  assert.deepEqual(calls, { dispatch: 1, workspace: 1, evidence: 1 });
});

test('fails before dispatch when the PR has no explicit linked issue', () => {
  const { result, calls } = resolve({ pullRequest: { body: 'No issue linkage' } });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'pr-continuation-linked-issue-missing');
  assert.deepEqual(calls, { dispatch: 0, workspace: 0, evidence: 0 });
});

test('fails before dispatch when the PR links more than one issue', () => {
  const { result, calls } = resolve({ pullRequest: { body: 'Fixes #241\nAlso closes #242' } });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'pr-continuation-linked-issue-ambiguous');
  assert.deepEqual(result.linkedIssueNumbers, [241, 242]);
  assert.deepEqual(calls, { dispatch: 0, workspace: 0, evidence: 0 });
});

test('fails before dispatch when the fetched issue does not match the unique PR link', () => {
  const { result, calls } = resolve({ issue: { number: 242 } });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'pr-continuation-linked-issue-mismatch');
  assert.deepEqual(calls, { dispatch: 0, workspace: 0, evidence: 0 });
});

test('revoked manager authority fails before dispatch or workspace inspection', () => {
  const packet = managerPacket();
  const revoked = { id: 2, createdAt: '2026-08-17T19:01:00Z', body: '## Manager preflight packet — revoked\nDo not dispatch.' };
  const { result, calls } = resolve({ issueComments: [packet, revoked] });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'pr-continuation-manager-authority-refused');
  assert.deepEqual(calls, { dispatch: 0, workspace: 0, evidence: 0 });
});

test('dispatch refusal and non-implementation authorization fail before workspace inspection', () => {
  const dispatchFailure = resolve({ dispatchIdentity: { ok: false, failureReason: 'repository-scope-legacy-conflict', failureScope: 'issue_not_runnable' } });
  assert.equal(dispatchFailure.result.allowed, false);
  assert.equal(dispatchFailure.result.failureReason, 'repository-scope-legacy-conflict');
  assert.deepEqual(dispatchFailure.calls, { dispatch: 1, workspace: 0, evidence: 0 });

  const authorizationFailure = resolve({ dispatchIdentity: { executionAuthorization: { allowed: false, phase: 'implementation' } } });
  assert.equal(authorizationFailure.result.allowed, false);
  assert.equal(authorizationFailure.result.failureReason, 'pr-continuation-execution-authorization-refused');
  assert.deepEqual(authorizationFailure.calls, { dispatch: 1, workspace: 0, evidence: 0 });
});

test('PR repository or branch mismatch fails before workspace inspection', () => {
  const repoMismatch = resolve({ pullRequest: { head: { repo: { full_name: 'Other/repo' }, ref: BRANCH, sha: HEAD } } });
  assert.equal(repoMismatch.result.failureReason, 'pr-continuation-pr-repository-mismatch');
  assert.deepEqual(repoMismatch.calls, { dispatch: 1, workspace: 0, evidence: 0 });

  const branchMismatch = resolve({ pullRequest: { head: { repo: { full_name: REPO }, ref: 'other/branch', sha: HEAD } } });
  assert.equal(branchMismatch.result.failureReason, 'pr-continuation-pr-branch-mismatch');
  assert.deepEqual(branchMismatch.calls, { dispatch: 1, workspace: 0, evidence: 0 });
});

test('missing continuation workspace is propagated without evidence capture', () => {
  const { result, calls } = resolve({ workspace: { allowed: false, failureReason: 'continuation-worktree-missing' } });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'continuation-worktree-missing');
  assert.deepEqual(calls, { dispatch: 1, workspace: 1, evidence: 0 });
});

test('workspace must start at the exact published PR head SHA', () => {
  const { result, calls } = resolve({ workspace: { baseHead: 'd'.repeat(40) } });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'pr-continuation-pr-head-worktree-mismatch');
  assert.deepEqual(calls, { dispatch: 1, workspace: 1, evidence: 0 });
});

test('captured worktree must remain on the exact branch and exact PR head', () => {
  const branchMismatch = resolve({ evidence: { branch: 'other/branch' } });
  assert.equal(branchMismatch.result.failureReason, 'pr-continuation-worktree-branch-mismatch');
  assert.deepEqual(branchMismatch.calls, { dispatch: 1, workspace: 1, evidence: 1 });

  const headMismatch = resolve({ evidence: { head: 'e'.repeat(40) } });
  assert.equal(headMismatch.result.failureReason, 'pr-continuation-pr-head-worktree-mismatch');
  assert.deepEqual(headMismatch.calls, { dispatch: 1, workspace: 1, evidence: 1 });
});

test('dirty continuation worktree fails closed without cleanup or execution', () => {
  const { result, calls } = resolve({ evidence: { dirtyEntryCount: 2, statusFingerprint: 'sha256:dirty' } });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'pr-continuation-worktree-dirty');
  assert.equal(result.dirtyEntryCount, 2);
  assert.deepEqual(calls, { dispatch: 1, workspace: 1, evidence: 1 });
});
