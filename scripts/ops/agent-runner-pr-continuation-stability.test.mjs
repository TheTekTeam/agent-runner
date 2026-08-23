// #242 corrective acceptance: the PR-continuation path proved as a *system*,
// against real temporary git repositories and worktrees.
//
// The previous #242 tests passed while the live field run failed, because
// they handed the runner a pre-committed fake worktree and never exercised
// the actual worker/prompt contract. The field failure
// (`implementation-uncommitted-changes`) happened precisely in the gap those
// mocks skipped: the worker edited a file and never committed, because the
// review-only prompt never told it to.
//
// These tests therefore drive the real code path end to end -- a real bare
// origin, a real clone, a real runner-owned worktree, a real `git push`, and
// a deterministic fake worker process whose *behaviour* (edit-and-commit,
// edit-without-commit, commit-then-dirty) is the variable under test.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildPrContinuationPromptSections,
  prContinuationAttemptId,
  prContinuationPromptCacheMetadata,
  PR_REVIEW_FOLLOWUP_MODE,
  publishPrContinuation,
  runOrPlanClaude,
  verifyPrContinuationRecoveryCheckpoint,
} from './claude-runner.mjs';
import { resolvePrContinuationBinding } from './agent-runner-pr-continuation-binding.mjs';
import {
  acquireImplementationSlot,
  markInheritedImplementationSlot,
  SLOT_INHERITED_ENV,
} from './agent-runner-implementation-slot.mjs';
import {
  renderExecutableReviewInstructions,
  selectExecutableReviewFeedback,
} from './claude-runner-review-followup.mjs';
import { EXECUTION_PHASE_IMPLEMENTATION } from './claude-runner-execution-policy.mjs';
import { readRestrictedRecoveryHandle } from './claude-runner-recovery-adapter.mjs';

const PR_NUMBER = 304;
const REPO = 'TheTekTeam/agent-runner';
const BRANCH = 'claude/field-canary-pr-continuation-303';
const WORKTREE_NAME = 'pr-continuation-303';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A real git fixture: bare origin + clone + runner-owned worktree on the
 * authorised branch, plus a fake `gh`/`claude` bin dir. Nothing here is
 * mocked at the git layer -- pushes really move refs in the bare origin, so a
 * test can prove a push did or did not happen by reading it.
 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pr-continuation-242-'));
  const originPath = join(root, 'origin.git');
  const repoPath = join(root, 'repo');
  const binPath = join(root, 'bin');
  const outputDir = join(root, 'out');
  mkdirSync(binPath, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  execFileSync('git', ['init', '--bare', '--initial-branch=main', originPath]);
  execFileSync('git', ['clone', originPath, repoPath]);
  git(repoPath, 'config', 'user.email', 'runner@example.invalid');
  git(repoPath, 'config', 'user.name', 'Agent Runner Test');
  writeFileSync(join(repoPath, 'README.md'), 'base\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'base');
  git(repoPath, 'push', 'origin', 'main');

  // The already-authorised continuation branch and the exact runner-owned
  // worktree the failed field run reused.
  const worktreePath = join(repoPath, '.claude', 'worktrees', WORKTREE_NAME);
  git(repoPath, 'branch', BRANCH);
  git(repoPath, 'worktree', 'add', worktreePath, BRANCH);
  git(worktreePath, 'config', 'user.email', 'runner@example.invalid');
  git(worktreePath, 'config', 'user.name', 'Agent Runner Test');
  writeFileSync(join(worktreePath, 'canary.md'), 'canary\n');
  git(worktreePath, 'add', 'canary.md');
  git(worktreePath, 'commit', '-m', 'canary base');
  git(worktreePath, 'push', 'origin', BRANCH);
  const publishedHead = git(worktreePath, 'rev-parse', 'HEAD');

  // Fake `gh pr view`: reports the same open PR, and derives headRefOid from
  // the *actual* repository state so a test can never accidentally assert a
  // hard-coded agreement between local and remote.
  writeFileSync(join(binPath, 'gh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `state="\${FAKE_GH_PR_STATE:-OPEN}"`,
    `headref="\${FAKE_GH_HEAD_REF:-${BRANCH}}"`,
    `number="\${FAKE_GH_PR_NUMBER:-${PR_NUMBER}}"`,
    `oid=$(git --git-dir="${originPath}" rev-parse "refs/heads/$headref" 2>/dev/null || echo "")`,
    'printf \'{"number":%s,"state":"%s","headRefName":"%s","headRefOid":"%s","url":"https://example.invalid/pr"}\\n' + '\' "$number" "$state" "$headref" "$oid"',
  ].join('\n'), { mode: 0o755 });

  writeFileSync(join(binPath, 'claude'), [
    '#!/usr/bin/env bash',
    'echo "2.9.0 (Claude Code)"',
  ].join('\n'), { mode: 0o755 });

  return {
    root, originPath, repoPath, worktreePath, binPath, outputDir, publishedHead,
    originHead: (branch = BRANCH) => {
      const result = spawnSync('git', ['--git-dir', originPath, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' });
      return result.status === 0 ? String(result.stdout).trim() : null;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const worktreeIdentity = { name: WORKTREE_NAME, expectedBranch: BRANCH };

function continuationRunPlan(fixture, overrides = {}) {
  return {
    mode: PR_REVIEW_FOLLOWUP_MODE,
    pr: PR_NUMBER,
    prNumber: PR_NUMBER,
    repo: REPO,
    executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
    executionAuthorization: { allowed: true, phase: EXECUTION_PHASE_IMPLEMENTATION, permissionMode: 'dontAsk' },
    costAdmission: { allowed: true },
    worktreeIdentity,
    repositoryContext: { implementationRepository: REPO, implementationCheckout: fixture.repoPath },
    profile: { profile: 'complex', model: 'sonnet', effort: 'low' },
    preRunHeadSha: fixture.publishedHead,
    ...overrides,
  };
}

function continuationArgs(fixture, overrides = {}) {
  return {
    execute: true,
    outputDir: fixture.outputDir,
    quotaStatePath: join(fixture.outputDir, 'quota-state.json'),
    claudeBin: 'claude',
    inheritProviderAuth: false,
    ...overrides,
  };
}

function successEnvelope() {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'done' });
}

/**
 * A deterministic fake worker. `behaviour` is the whole point of these
 * tests: it reproduces exactly what a real Claude worker does or fails to do
 * inside the worktree.
 */
function fakeWorker(fixture, behaviour) {
  return () => {
    if (behaviour === 'edit-and-commit') {
      writeFileSync(join(fixture.worktreePath, 'canary.md'), 'canary\nreview correction applied\n');
      git(fixture.worktreePath, 'add', 'canary.md');
      git(fixture.worktreePath, 'commit', '--no-verify', '-m', 'address review feedback');
    } else if (behaviour === 'edit-without-commit') {
      // The exact field failure: the requested edit is made and never committed.
      writeFileSync(join(fixture.worktreePath, 'canary.md'), 'canary\nreview correction applied\n');
    } else if (behaviour === 'commit-then-dirty') {
      writeFileSync(join(fixture.worktreePath, 'canary.md'), 'canary\nreview correction applied\n');
      git(fixture.worktreePath, 'add', 'canary.md');
      git(fixture.worktreePath, 'commit', '--no-verify', '-m', 'address review feedback');
      writeFileSync(join(fixture.worktreePath, 'stray.md'), 'uncommitted residue\n');
    }
    return { status: 0, signal: null, stdout: successEnvelope(), stderr: '', error: null };
  };
}

function runEnv(fixture, extra = {}) {
  return {
    PATH: `${fixture.binPath}:${process.env.PATH}`,
    HOME: fixture.root,
    AGENT_RUNNER_IMPLEMENTATION_LOCK: join(fixture.root, 'slot.lock'),
    ...extra,
  };
}

async function runContinuation(fixture, behaviour, { args = {}, runPlan = {}, env = {}, prePublicationCheck = null } = {}) {
  const originalPath = process.env.PATH;
  const originalLog = console.log;
  // verifyClaudeImplementationCli resolves `claude` from the real process
  // environment, so the fake CLI must be visible there too.
  process.env.PATH = `${fixture.binPath}:${originalPath}`;
  console.log = () => {};
  try {
    return await runOrPlanClaude({
      args: continuationArgs(fixture, args),
      env: runEnv(fixture, env),
      label: `pr-${PR_NUMBER}`,
      runPlan: continuationRunPlan(fixture, runPlan),
      prompt: 'bounded continuation fixture',
      claudeArgs: [],
      processRunner: fakeWorker(fixture, behaviour),
      prePublicationCheck,
    });
  } finally {
    process.env.PATH = originalPath;
    console.log = originalLog;
  }
}

function latestRunLog(fixture) {
  const files = readdirSync(fixture.outputDir)
    .filter((name) => name.startsWith(`pr-${PR_NUMBER}-`) && name.endsWith('.json'))
    .sort();
  assert.ok(files.length > 0, 'the run must have written a run log');
  return JSON.parse(readFileSync(join(fixture.outputDir, files[files.length - 1]), 'utf8'));
}

// ---------------------------------------------------------------------------
// Defect 1: the prompt contract that actually failed in the field.
// ---------------------------------------------------------------------------

function promptInput(overrides = {}) {
  return {
    issue: { number: 303, title: 'FIELD.CANARY.PR.CONTINUATION.1', body: 'disposable canary issue body' },
    pullRequest: { number: PR_NUMBER, title: 'canary PR' },
    prNumber: PR_NUMBER,
    branch: BRANCH,
    instructions: [{
      source: 'review-thread',
      threadId: 'thread-1',
      author: 'manager',
      authorAssociation: 'OWNER',
      body: 'Same-PR continuation field proof pending.',
      createdAt: '2026-08-23T10:00:00Z',
    }],
    profile: { profile: 'complex', model: 'sonnet', effort: 'low' },
    clearContext: true,
    worktreeIdentity,
    repositoryContext: { implementationRepository: REPO, implementationCheckout: '/repo', implementationInstructionPaths: ['AGENTS.md'] },
    authorityRevision: 'AR-TEST-1',
    ...overrides,
  };
}

test('#242 defect 1: PR continuation prompt carries the canonical clean-commit implementation invariant', () => {
  const { prompt, stableText } = buildPrContinuationPromptSections(promptInput());
  // This exact instruction was absent from the live failed run's prompt.
  assert.match(prompt, /Finish with a clean commit on that exact branch using `git commit --no-verify \.\.\.`/);
  assert.match(stableText, /Finish with a clean commit on that exact branch/);
  // Reused, not re-worded: the invariant sits in the cacheable stable prefix.
  assert.match(stableText, /Execution phase: implementation/);
  assert.match(stableText, /Do not leave, rename, delete, or switch the assigned isolated worktree\/branch/);
  assert.match(stableText, /Do not push or call GitHub/);
  assert.match(stableText, /Follow AGENTS\.md/);
  assert.match(stableText, /Final report schema/);
});

test('#242 defect 3: review feedback is framed as bounded correction input, never new authority', () => {
  const { prompt, stableText } = buildPrContinuationPromptSections(promptInput());
  assert.match(stableText, /bounded correction input, not a new instruction set/);
  assert.match(stableText, /remain the only implementation scope/);
  assert.match(stableText, /Do not resolve, dismiss or reply to review threads/);
  assert.match(stableText, /Do not approve, merge, close the issue, or open another pull request/);
  // The feedback text itself is mutable evidence, never part of the stable prefix.
  assert.match(prompt, /Same-PR continuation field proof pending\./);
  assert.ok(!stableText.includes('Same-PR continuation field proof pending.'));
});

test('#242 defect 2: PR continuation emits a non-null #193 stable-prefix fingerprint and #194-shaped cache metadata', () => {
  const metadata = prContinuationPromptCacheMetadata(promptInput());
  // The live failed run reported stablePrefixFingerprint: null.
  assert.notEqual(metadata.stablePrefixFingerprint, null);
  assert.match(metadata.stablePrefixFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(metadata.dynamicSuffixFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(metadata.schemaVersion, 'agent-runner-prompt-compiler/v1');
  assert.equal(metadata.adapterId, 'claude-code-cli');
  assert.equal(metadata.model, 'sonnet');
  assert.equal(metadata.cacheStrategy, 'provider-managed');
  assert.ok(metadata.stablePrefixByteEstimate > 0);
});

test('#242 defect 2: the stable prefix is stable across differing review feedback, and the dynamic suffix is not', () => {
  const first = prContinuationPromptCacheMetadata(promptInput());
  const second = prContinuationPromptCacheMetadata(promptInput({
    instructions: [{ source: 'review-thread', threadId: 't2', author: 'manager', authorAssociation: 'OWNER', body: 'different bounded request', createdAt: '2026-08-23T11:00:00Z' }],
  }));
  assert.equal(first.stablePrefixFingerprint, second.stablePrefixFingerprint);
  assert.notEqual(first.dynamicSuffixFingerprint, second.dynamicSuffixFingerprint);
});

// ---------------------------------------------------------------------------
// Defect 3: reviewer trust.
// ---------------------------------------------------------------------------

test('#242 defect 3: an unresolved thread from an untrusted author is not executable input', () => {
  const result = selectExecutableReviewFeedback({
    reviews: [],
    reviewThreads: [{ id: 't1', isResolved: false, comments: [{ author: { login: 'drive-by' }, authorAssociation: 'NONE', body: 'do something else entirely' }] }],
  });
  assert.equal(result.executable, false);
  assert.equal(result.failureReason, 'pr-continuation-review-authors-untrusted');
  assert.equal(result.rejectedAuthorCount, 1);
  assert.deepEqual([...result.instructions], []);
});

test('#242 defect 3: a missing author association is never trusted', () => {
  const result = selectExecutableReviewFeedback({
    reviews: [],
    reviewThreads: [{ id: 't1', isResolved: false, comments: [{ author: { login: 'ghost' }, body: 'unattributed instruction' }] }],
  });
  assert.equal(result.executable, false);
  assert.equal(result.failureReason, 'pr-continuation-review-authors-untrusted');
});

test('#242 defect 3: owner/member/collaborator review feedback is executable and bounded', () => {
  const result = selectExecutableReviewFeedback({
    reviews: [{ user: { login: 'gp' }, state: 'CHANGES_REQUESTED', body: 'please fix', author_association: 'OWNER', submitted_at: '2026-08-23T09:00:00Z' }],
    reviewThreads: [{ id: 't1', isResolved: false, comments: [{ author: { login: 'mate' }, authorAssociation: 'COLLABORATOR', body: 'inline note' }] }],
  });
  assert.equal(result.executable, true);
  assert.equal(result.instructions.length, 2);
  assert.deepEqual([...result.unresolvedThreadIds], ['t1']);
  assert.match(renderExecutableReviewInstructions(result.instructions), /OWNER/);
});

test('#242 defect 3: resolved threads and COMMENT-only reviews are not executable input', () => {
  const result = selectExecutableReviewFeedback({
    reviews: [{ user: { login: 'gp' }, state: 'COMMENTED', body: 'nice work', author_association: 'OWNER', submitted_at: '2026-08-23T09:00:00Z' }],
    reviewThreads: [{ id: 't1', isResolved: true, comments: [{ author: { login: 'gp' }, authorAssociation: 'OWNER', body: 'already handled' }] }],
  });
  assert.equal(result.executable, false);
  assert.equal(result.failureReason, 'pr-continuation-no-unresolved-review-instruction');
});

test('#242 defect 3: executable instruction bodies and counts are bounded', () => {
  const threads = Array.from({ length: 40 }, (_, index) => ({
    id: `t${index}`,
    isResolved: false,
    comments: [{ author: { login: 'gp' }, authorAssociation: 'OWNER', body: 'x'.repeat(9000) }],
  }));
  const result = selectExecutableReviewFeedback({ reviews: [], reviewThreads: threads });
  assert.equal(result.executable, true);
  assert.equal(result.instructions.length, 20);
  assert.equal(result.truncatedInstructionCount, 20);
  assert.ok(result.instructions.every((instruction) => instruction.body.length <= 2000));
});

// ---------------------------------------------------------------------------
// Defect 6: the one global implementation slot.
// ---------------------------------------------------------------------------

test('#242 defect 6: the global implementation slot admits one holder and refuses a second', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slot-242-'));
  try {
    const env = { AGENT_RUNNER_IMPLEMENTATION_LOCK: join(dir, 'slot.lock') };
    const first = acquireImplementationSlot({ env });
    assert.equal(first.held, true);
    assert.equal(first.inherited, false);

    const second = acquireImplementationSlot({ env });
    assert.equal(second.held, false);
    assert.equal(second.failureReason, 'implementation-slot-unavailable');

    first.release();
    const third = acquireImplementationSlot({ env });
    assert.equal(third.held, true);
    third.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#242 defect 6: a descendant of the slot owner inherits the slot instead of deadlocking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slot-242-inherit-'));
  try {
    const env = { AGENT_RUNNER_IMPLEMENTATION_LOCK: join(dir, 'slot.lock') };
    const owner = acquireImplementationSlot({ env });
    assert.equal(owner.held, true);

    // Exactly what the recurrence -> run-project.sh -> cron -> runner chain does.
    const childEnv = markInheritedImplementationSlot(env, process.pid);
    const child = acquireImplementationSlot({ env: childEnv });
    assert.equal(child.held, true);
    assert.equal(child.inherited, true);

    // Releasing an inherited slot must not release the owner's lock.
    child.release();
    assert.equal(existsSync(join(dir, 'slot.lock')), true);
    owner.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#242 defect 6: a stale inherited-slot declaration fails closed rather than granting a slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slot-242-stale-'));
  try {
    const env = {
      AGENT_RUNNER_IMPLEMENTATION_LOCK: join(dir, 'slot.lock'),
      [SLOT_INHERITED_ENV]: '4194304',
    };
    const result = acquireImplementationSlot({ env, isAlive: () => false });
    assert.equal(result.held, false);
    assert.equal(result.failureReason, 'implementation-slot-inheritance-stale');
    // Fails closed: it never silently took the lock instead.
    assert.equal(existsSync(join(dir, 'slot.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#242 defect 6: a write-capable continuation refuses to start while the global slot is held elsewhere', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const holder = acquireImplementationSlot({ env: { AGENT_RUNNER_IMPLEMENTATION_LOCK: join(fixture.root, 'slot.lock') } });
  assert.equal(holder.held, true);
  t.after(() => holder.release());

  let workerStarted = false;
  const originalPath = process.env.PATH;
  const originalLog = console.log;
  process.env.PATH = `${fixture.binPath}:${originalPath}`;
  console.log = () => {};
  let exitCode;
  try {
    exitCode = await runOrPlanClaude({
      args: continuationArgs(fixture),
      env: runEnv(fixture),
      label: `pr-${PR_NUMBER}`,
      runPlan: continuationRunPlan(fixture),
      prompt: 'bounded continuation fixture',
      claudeArgs: [],
      processRunner: () => { workerStarted = true; return { status: 0, signal: null, stdout: successEnvelope(), stderr: '', error: null }; },
    });
  } finally {
    process.env.PATH = originalPath;
    console.log = originalLog;
  }
  assert.equal(exitCode, 4);
  assert.equal(workerStarted, false);
  assert.equal(fixture.originHead(), fixture.publishedHead, 'no push may occur when the slot is unavailable');
});

// ---------------------------------------------------------------------------
// The field boundary itself: worker behaviour -> outcome.
// ---------------------------------------------------------------------------

test('#242 field acceptance: unresolved review -> bounded edit -> COMMIT -> same-PR publication', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);

  const exitCode = await runContinuation(fixture, 'edit-and-commit');
  assert.equal(exitCode, 0);

  const log = latestRunLog(fixture);
  assert.equal(log.failureReason, null);
  assert.equal(log.implementationEvidence.valid, true);
  assert.equal(log.implementationEvidence.committed, true);
  assert.equal(log.implementationEvidence.clean, true);
  assert.equal(log.implementationPublication.published, true);

  // Same PR number, and the remote head is exactly the committed local head.
  const committedHead = git(fixture.worktreePath, 'rev-parse', 'HEAD');
  assert.equal(log.implementationPublication.prNumber, PR_NUMBER);
  assert.equal(log.implementationPublication.headSha, committedHead);
  assert.equal(fixture.originHead(), committedHead);
  assert.notEqual(fixture.originHead(), fixture.publishedHead);

  // Canonical main is untouched by the worker, and the published commit is a
  // fast-forward descendant -- no force-push, no rewritten history.
  assert.equal(fixture.originHead('main'), git(fixture.repoPath, 'rev-parse', 'origin/main'));
  const ancestry = spawnSync('git', ['--git-dir', fixture.originPath, 'merge-base', '--is-ancestor', fixture.publishedHead, committedHead]);
  assert.equal(ancestry.status, 0, 'published head must descend from the reviewed head');
  assert.equal(log.implementationSlot.held, true);
});

test('#242 root cause: a worker that edits but never commits fails truthfully and preserves the work', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);

  const exitCode = await runContinuation(fixture, 'edit-without-commit');
  assert.notEqual(exitCode, 0);

  const log = latestRunLog(fixture);
  // Exactly the live field failure classification -- truthful, not a false success.
  assert.equal(log.failureReason, 'implementation-uncommitted-changes');
  assert.equal(log.implementationEvidence.valid, false);
  assert.equal(log.implementationEvidence.committed, false);
  assert.equal(log.implementationPublication, null);

  // Nothing was published, and the worker's real edit is still on disk.
  assert.equal(fixture.originHead(), fixture.publishedHead, 'a failed run must never push');
  assert.match(readFileSync(join(fixture.worktreePath, 'canary.md'), 'utf8'), /review correction applied/);

  // A deterministic restricted checkpoint was recorded so the next run can
  // recover instead of dead-ending on the dirty worktree.
  const read = readRestrictedRecoveryHandle(fixture.outputDir, prContinuationAttemptId({ repo: REPO, prNumber: PR_NUMBER }));
  assert.equal(read.permissionSafe, true);
  assert.equal(read.available, true);
  assert.equal(read.handle.continuationKind, 'pr-continuation');
  assert.equal(read.handle.continuationRepository, REPO);
  assert.equal(read.handle.continuationPrNumber, PR_NUMBER);
  assert.equal(read.handle.expectedBranch, BRANCH);
  assert.equal(read.handle.checkpointHead, fixture.publishedHead);
  assert.ok(read.handle.checkpointStatusFingerprint);
});

test('#242 defect 5: a committed change with dirty residue is refused and never published', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);

  const exitCode = await runContinuation(fixture, 'commit-then-dirty');
  assert.notEqual(exitCode, 0);

  const log = latestRunLog(fixture);
  assert.equal(log.failureReason, 'implementation-worktree-dirty');
  assert.equal(log.implementationEvidence.valid, false);
  assert.equal(log.implementationPublication, null);
  assert.equal(fixture.originHead(), fixture.publishedHead, 'a dirty result must never push');
});

// ---------------------------------------------------------------------------
// Defect 4: recovery from a preserved failed continuation.
// ---------------------------------------------------------------------------

// A canonical manager preflight packet, in the exact accepted schema, so the
// binding resolves real continuation authority rather than a stub.
function managerPreflightComment() {
  return {
    id: 5383409913,
    user: { login: 'gpcola' },
    created_at: '2026-08-23T08:00:00Z',
    body: [
      '<!-- agent-runner:manager-preflight -->',
      '',
      '```yaml',
      'schema_version: agent-runner-manager-preflight/v1',
      'revision: AR-PR-CONTINUATION-242.1',
      `fingerprint: sha256:${'a'.repeat(64)}`,
      'producer_type: normal_chatgpt_manager_session',
      'approved_agent: claude-code-cli',
      'execution_phase: implementation',
      'profile: complex',
      'model: sonnet',
      'effort: low',
      'scope:',
      '  - bounded continuation scope',
      'required_validation:',
      '  - node --test focused',
      'stop_conditions:',
      '  - stop on scope expansion',
      '```',
    ].join('\n'),
  };
}

function bindingDeps(fixture, extra = {}) {
  return {
    pullRequest: {
      number: PR_NUMBER,
      state: 'open',
      title: 'canary PR',
      body: `Implements #303`,
      head: { ref: BRANCH, sha: fixture.publishedHead, repo: { full_name: REPO } },
    },
    issue: { number: 303, title: 'canary', body: 'canary' },
    issueComments: [managerPreflightComment()],
    repo: REPO,
    env: runEnv(fixture),
    resolveDispatchIdentity: () => ({
      ok: true,
      executionAuthorization: { allowed: true, phase: 'implementation', permissionMode: 'dontAsk' },
      worktreeIdentity,
      dispatchAuthority: { repository: REPO, branch: BRANCH },
      repositoryContext: { implementationRepository: REPO, implementationCheckout: fixture.repoPath },
      profileName: 'complex',
      managerExecutionMeta: { model: 'sonnet', effort: 'low' },
    }),
    ...extra,
  };
}

async function failedContinuationFixture(t) {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  await runContinuation(fixture, 'edit-without-commit');
  return fixture;
}

test('#242 defect 4: the exact preserved failed checkpoint is recoverable, and nothing is reset or discarded', async (t) => {
  const fixture = await failedContinuationFixture(t);
  const before = readFileSync(join(fixture.worktreePath, 'canary.md'), 'utf8');

  const verdict = verifyPrContinuationRecoveryCheckpoint({
    outputDir: fixture.outputDir,
    repository: REPO,
    prNumber: PR_NUMBER,
    branch: BRANCH,
    headSha: fixture.publishedHead,
    worktreeIdentity,
    statusFingerprint: readRestrictedRecoveryHandle(
      fixture.outputDir, prContinuationAttemptId({ repo: REPO, prNumber: PR_NUMBER }),
    ).handle.checkpointStatusFingerprint,
  });
  assert.equal(verdict.recoverable, true);

  // Verification is read-only: the preserved work is byte-identical afterwards.
  assert.equal(readFileSync(join(fixture.worktreePath, 'canary.md'), 'utf8'), before);
});

test('#242 defect 4: an unrelated modification to the preserved worktree fails closed', async (t) => {
  const fixture = await failedContinuationFixture(t);
  const handle = readRestrictedRecoveryHandle(
    fixture.outputDir, prContinuationAttemptId({ repo: REPO, prNumber: PR_NUMBER }),
  ).handle;

  const verdict = verifyPrContinuationRecoveryCheckpoint({
    outputDir: fixture.outputDir,
    repository: REPO,
    prNumber: PR_NUMBER,
    branch: BRANCH,
    headSha: fixture.publishedHead,
    worktreeIdentity,
    // Any unrelated edit changes the status fingerprint.
    statusFingerprint: `${handle.checkpointStatusFingerprint}-modified`,
  });
  assert.equal(verdict.recoverable, false);
  assert.equal(verdict.failureReason, 'pr-continuation-recovery-worktree-modified');
});

test('#242 defect 4: a checkpoint from a different PR, branch or head is never accepted', async (t) => {
  const fixture = await failedContinuationFixture(t);
  const attemptId = prContinuationAttemptId({ repo: REPO, prNumber: PR_NUMBER });
  const fingerprint = readRestrictedRecoveryHandle(fixture.outputDir, attemptId).handle.checkpointStatusFingerprint;
  const base = {
    outputDir: fixture.outputDir, repository: REPO, prNumber: PR_NUMBER, branch: BRANCH,
    headSha: fixture.publishedHead, worktreeIdentity, statusFingerprint: fingerprint,
  };

  assert.equal(verifyPrContinuationRecoveryCheckpoint({ ...base, prNumber: 999 }).failureReason, 'pr-continuation-no-preserved-checkpoint');
  assert.equal(verifyPrContinuationRecoveryCheckpoint({ ...base, branch: 'other-branch' }).failureReason, 'pr-continuation-recovery-branch-mismatch');
  assert.equal(verifyPrContinuationRecoveryCheckpoint({ ...base, headSha: 'f'.repeat(40) }).failureReason, 'pr-continuation-recovery-head-mismatch');
  assert.equal(verifyPrContinuationRecoveryCheckpoint({ ...base, repository: 'Other/repo' }).failureReason, 'pr-continuation-no-preserved-checkpoint');
});

test('#242 defect 4: binding refuses a dirty worktree with no preserved checkpoint, and accepts the verified one', async (t) => {
  const fixture = await failedContinuationFixture(t);

  const refused = resolvePrContinuationBinding({
    ...bindingDeps(fixture),
    prepareWorkspace: () => ({
      allowed: true, baseHead: fixture.publishedHead, rootPath: fixture.repoPath, worktreePath: fixture.worktreePath,
    }),
    captureEvidence: () => ({ head: fixture.publishedHead, branch: BRANCH, dirtyEntryCount: 1, statusFingerprint: 'abc' }),
    verifyRecoveryCheckpoint: null,
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.failureReason, 'pr-continuation-worktree-dirty');
  assert.equal(refused.recoveryFailureReason, 'pr-continuation-no-preserved-checkpoint');

  const accepted = resolvePrContinuationBinding({
    ...bindingDeps(fixture),
    prepareWorkspace: () => ({
      allowed: true, baseHead: fixture.publishedHead, rootPath: fixture.repoPath, worktreePath: fixture.worktreePath,
    }),
    captureEvidence: () => ({ head: fixture.publishedHead, branch: BRANCH, dirtyEntryCount: 1, statusFingerprint: 'abc' }),
    verifyRecoveryCheckpoint: () => ({ recoverable: true, failureReason: null, handleDigest: 'digest' }),
  });
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.recoveredCheckpoint.recovered, true);
  assert.equal(accepted.recoveredCheckpoint.dirtyEntryCount, 1);
});

test('#242 regression: a clean published-head worktree still binds without any recovery path', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const binding = resolvePrContinuationBinding({
    ...bindingDeps(fixture),
    prepareWorkspace: () => ({
      allowed: true, baseHead: fixture.publishedHead, rootPath: fixture.repoPath, worktreePath: fixture.worktreePath,
    }),
    captureEvidence: () => ({ head: fixture.publishedHead, branch: BRANCH, dirtyEntryCount: 0, statusFingerprint: 'clean' }),
    verifyRecoveryCheckpoint: () => { throw new Error('recovery must not be consulted for a clean worktree'); },
  });
  assert.equal(binding.allowed, true);
  assert.equal(binding.recoveredCheckpoint, null);
  assert.equal(binding.preRunHeadSha, fixture.publishedHead);
});

// ---------------------------------------------------------------------------
// Defect 5: publication race safety.
// ---------------------------------------------------------------------------

for (const [name, refusal] of [
  ['PR closed while the model ran', 'pr-continuation-revalidation-pr-not-open'],
  ['remote head advanced while the model ran', 'pr-continuation-revalidation-remote-head-advanced'],
  ['manager authority revoked while the model ran', 'pr-continuation-revalidation-authority-revoked'],
]) {
  test(`#242 defect 5: ${name} -> refuse publication, never push`, async (t) => {
    const fixture = makeFixture();
    t.after(fixture.cleanup);

    const exitCode = await runContinuation(fixture, 'edit-and-commit', {
      prePublicationCheck: async () => ({ allowed: false, failureReason: refusal }),
    });
    assert.notEqual(exitCode, 0);

    const log = latestRunLog(fixture);
    assert.equal(log.prePublicationRevalidation.allowed, false);
    assert.equal(log.implementationEvidence.failureReason, refusal);
    assert.equal(log.implementationPublication, null);
    // The commit is preserved locally; the remote is untouched.
    assert.equal(fixture.originHead(), fixture.publishedHead);
    assert.notEqual(git(fixture.worktreePath, 'rev-parse', 'HEAD'), fixture.publishedHead);
  });
}

test('#242 defect 5: publication refuses a renumbered PR and never opens a replacement', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.worktreePath, 'canary.md'), 'canary\nchange\n');
  git(fixture.worktreePath, 'add', 'canary.md');
  git(fixture.worktreePath, 'commit', '--no-verify', '-m', 'change');

  const result = publishPrContinuation({
    workspace: { worktreePath: fixture.worktreePath },
    worktreeIdentity,
    repo: REPO,
    prNumber: PR_NUMBER,
    env: runEnv(fixture, { FAKE_GH_PR_NUMBER: '999' }),
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-pr-number-changed');
});

test('#242 defect 5: publication refuses when the PR head branch was repointed', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.worktreePath, 'canary.md'), 'canary\nchange\n');
  git(fixture.worktreePath, 'add', 'canary.md');
  git(fixture.worktreePath, 'commit', '--no-verify', '-m', 'change');

  const result = publishPrContinuation({
    workspace: { worktreePath: fixture.worktreePath },
    worktreeIdentity,
    repo: REPO,
    prNumber: PR_NUMBER,
    env: runEnv(fixture, { FAKE_GH_HEAD_REF: 'main' }),
  });
  assert.equal(result.published, false);
  assert.equal(result.failureReason, 'pr-continuation-publication-branch-changed');
});
