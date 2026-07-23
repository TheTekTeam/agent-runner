#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig, stripConfigArgs } from './agent-runner-config.mjs';
import { defaultRunnerStateDbPath, openRunnerStateStore } from './claude-runner-state.mjs';
import { probeProcessIdentity } from './claude-runner-cron.mjs';
import { evaluateGuardedCleanupPrecondition } from './agent-runner-workspace-ownership.mjs';

/**
 * Bounded, inspect-only-by-default operator command for the exact scenario
 * spec section 10 describes: an existing, currently-preserved workspace for
 * a specific issue (e.g. the #686 canary's leftover branch/worktree after
 * the proven claim-ordering failure) that needs to be understood *before*
 * anyone decides whether it may be reused, must be preserved as-is, or is
 * eligible for a guarded cleanup.
 *
 * The default (and only mode this file can reach without every one of the
 * flags below) is read-only: it inspects git state, the persisted runner
 * state DB, and open PRs, and prints sanitized JSON. It never runs
 * `git reset --hard`, `git clean`, or an unconditional branch delete.
 *
 * A mutating cleanup additionally requires: the exact issue, the exact
 * attempt id, the exact branch, the exact worktree path, the explicit
 * `--execute` flag, and — recomputed fresh at execute time, not reused from
 * the earlier inspection — proof that no process, lease, dirty file,
 * unpushed commit, or open PR remains. Any missing/failed fact refuses the
 * mutation and changes nothing.
 */

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    project: null,
    issue: null,
    inspectOnly: true,
    execute: false,
    attemptId: null,
    branch: null,
    worktree: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--project') args.project = next();
    else if (arg === '--issue') args.issue = Number.parseInt(next(), 10);
    else if (arg === '--inspect-only') args.inspectOnly = true;
    else if (arg === '--execute') { args.execute = true; args.inspectOnly = false; }
    else if (arg === '--attempt-id') args.attemptId = next();
    else if (arg === '--branch') args.branch = next();
    else if (arg === '--worktree') args.worktree = next();
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.help) {
    if (!args.project) throw new Error('--project is required');
    if (!Number.isInteger(args.issue) || args.issue <= 0) throw new Error('--issue must be a positive integer');
    if (args.execute && (!args.attemptId || !args.branch || !args.worktree)) {
      throw new Error('--execute requires --attempt-id, --branch and --worktree (the exact identifiers to reconcile)');
    }
  }
  return args;
}

export function printHelp() {
  console.log(`Agent Runner workspace reconciliation (#686)

Usage:
  node scripts/ops/agent-runner-reconcile-workspace.mjs --project <name> --issue <number> [--inspect-only]
  node scripts/ops/agent-runner-reconcile-workspace.mjs --project <name> --issue <number> \\
    --attempt-id <id> --branch <branch> --worktree <path> --execute

Default (and only reachable without every --execute flag): inspect-only. Prints sanitized JSON
describing matching recovery_attempts rows, git worktree/branch registrations, dirty/unpushed
state, process liveness, lease validity, linked open PRs, and a recommended safe action. Never
mutates anything.

A mutating cleanup additionally requires the exact --attempt-id, --branch and --worktree, the
explicit --execute flag, and — recomputed fresh, not reused from an earlier inspection — proof
that no process, lease, dirty file, unpushed commit or open PR remains. Any missing fact refuses
the mutation. Never runs \`git reset --hard\`, blind \`git clean\`, or an unconditional branch delete.
`);
}

function runGit(args, cwd) {
  try {
    return { ok: true, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (error) {
    return { ok: false, stdout: '', error: String(error?.message || error) };
  }
}

function runGh(args) {
  try {
    return { ok: true, stdout: execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (error) {
    return { ok: false, stdout: '', error: String(error?.message || error) };
  }
}

function issueTokenPattern(issueNumber) {
  return new RegExp(`(?:^|[-/])${Number(issueNumber)}(?:[-/]|$)`);
}

/**
 * Scans the local checkout for any branch or worktree registration whose
 * name references this issue number — the same conservative token match
 * `localRecoveryConflicts()` in claude-runner-cron.mjs already uses — rather
 * than requiring a fresh GitHub fetch of the current manager preflight just
 * to inspect what is already on disk.
 */
export function scanLocalWorkspaceEvidence(localRepoPath, issueNumber) {
  if (!localRepoPath || !existsSync(localRepoPath)) {
    return { available: false, branches: [], worktrees: [] };
  }
  const token = issueTokenPattern(issueNumber);
  const branchResult = runGit(['branch', '--format=%(refname:short)'], localRepoPath);
  const branchNames = branchResult.ok
    ? branchResult.stdout.split(/\r?\n/).filter(Boolean).filter((name) => token.test(name))
    : [];
  const branches = branchNames.map((name) => {
    const head = runGit(['rev-parse', name], localRepoPath);
    const upstream = runGit(['rev-parse', `origin/${name}`], localRepoPath);
    const headValue = head.ok ? head.stdout.trim() : null;
    const upstreamValue = upstream.ok ? upstream.stdout.trim() : null;
    return {
      name,
      head: headValue,
      pushedToOrigin: Boolean(upstreamValue) && upstreamValue === headValue,
    };
  });

  const worktreeListResult = runGit(['worktree', 'list', '--porcelain'], localRepoPath);
  const entries = worktreeListResult.ok
    ? worktreeListResult.stdout.split(/\n\s*\n/).filter(Boolean).filter((entry) => token.test(entry))
    : [];
  const worktrees = entries.map((entry) => {
    const path = entry.match(/^worktree (.+)$/m)?.[1] || null;
    const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1] || null;
    const head = entry.match(/^HEAD (.+)$/m)?.[1] || null;
    const status = path ? runGit(['status', '--porcelain=v1', '--untracked-files=all'], path) : { ok: false, stdout: '' };
    return {
      path,
      branch,
      head,
      dirty: status.ok ? status.stdout.trim().length > 0 : null,
      dirtyEvidenceAvailable: status.ok,
    };
  });

  return { available: true, branches, worktrees };
}

function sanitizedAttemptRow(row) {
  return {
    attemptId: row.attempt_id != null ? String(row.attempt_id) : null,
    claimRevision: row.claim_id || null,
    preflightRevision: row.preflight_revision || null,
    resolutionState: row.resolution_state || null,
    outcome: row.outcome || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    recoveryLeaseId: row.recovery_lease_id || null,
    hasProcessIdentity: Boolean(row.process_id),
  };
}

export async function collectWorkspaceReconciliationReport({
  repo, issueNumber, dbPath, localRepoPath, processProbe = probeProcessIdentity, ghRunner = runGh,
} = {}) {
  const store = existsSync(dbPath) ? openRunnerStateStore(dbPath) : null;
  let attempts = [];
  try {
    if (store) {
      attempts = store.allRows('recovery_attempts').filter((row) => row.repo === repo && row.issue_number === issueNumber);
    }
  } finally {
    store?.close();
  }

  const attemptsWithLiveness = [];
  for (const row of attempts) {
    let live = null;
    try {
      live = await processProbe({
        processId: row.process_id, processBootId: row.process_boot_id,
        processStartTicks: row.process_start_ticks, systemdInvocationId: row.systemd_invocation_id,
      });
    } catch {
      live = null;
    }
    attemptsWithLiveness.push({ ...sanitizedAttemptRow(row), processLive: live });
  }

  const local = scanLocalWorkspaceEvidence(localRepoPath, issueNumber);

  let linkedPrs = [];
  const prResult = ghRunner(['pr', 'list', '--repo', repo, '--state', 'open', '--search', String(issueNumber), '--json', 'number,title,url,headRefName,isDraft']);
  if (prResult.ok) {
    try {
      linkedPrs = JSON.parse(prResult.stdout || '[]').map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, headRefName: pr.headRefName, isDraft: pr.isDraft }));
    } catch {
      linkedPrs = [];
    }
  }

  const anyLiveAttempt = attemptsWithLiveness.some((row) => row.processLive === true);
  const anyUnresolvedAttempt = attempts.some((row) => !row.finished_at && !row.outcome);
  const anyDirty = local.worktrees.some((wt) => wt.dirty === true);
  const anyUnpushed = local.branches.some((branch) => branch.pushedToOrigin === false);
  const hasWorkspace = local.branches.length > 0 || local.worktrees.length > 0;

  let recommendedSafeAction;
  if (!hasWorkspace && attempts.length === 0) recommendedSafeAction = 'nothing-to-reconcile';
  else if (anyLiveAttempt) recommendedSafeAction = 'do-not-touch-live-attempt-in-progress';
  else if (linkedPrs.length > 0) recommendedSafeAction = 'preserve-linked-open-pr-requires-explicit-decision';
  else if (anyDirty || anyUnpushed) recommendedSafeAction = 'preserve-dirty-or-unpushed-state-requires-explicit-decision';
  else if (anyUnresolvedAttempt) recommendedSafeAction = 'inspect-unresolved-attempt-before-any-decision';
  else if (hasWorkspace) recommendedSafeAction = 'guarded-cleanup-may-be-eligible-recheck-preconditions-at-execute-time';
  else recommendedSafeAction = 'manual-operator-inspection';

  return {
    repo,
    issueNumber,
    matchingAttempts: attemptsWithLiveness,
    localWorkspaceEvidenceAvailable: local.available,
    branches: local.branches,
    worktrees: local.worktrees,
    linkedOpenPullRequests: linkedPrs,
    recommendedSafeAction,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Recomputes every guarded-cleanup fact fresh (never reused from an earlier
 * inspect-only call) for the exact attempt/branch/worktree the operator
 * named, and only then performs the narrowest possible cleanup: a plain
 * `git worktree remove` (no `--force`) and a plain `git branch -d` (safe
 * delete only — refuses on unmerged commits). Never `git reset --hard`,
 * never blind `git clean`, never `-D`/`--force`.
 */
export async function executeGuardedWorkspaceCleanup({
  repo, issueNumber, attemptId, branch, worktree, dbPath, localRepoPath, processProbe = probeProcessIdentity, ghRunner = runGh,
} = {}) {
  const report = await collectWorkspaceReconciliationReport({ repo, issueNumber, dbPath, localRepoPath, processProbe, ghRunner });
  const matchingAttempt = report.matchingAttempts.find((row) => row.attemptId === String(attemptId));
  const matchingBranch = report.branches.find((entry) => entry.name === branch);
  const matchingWorktree = report.worktrees.find((entry) => entry.path === worktree && entry.branch === branch);

  const precondition = evaluateGuardedCleanupPrecondition({
    noLiveProcess: !matchingAttempt || matchingAttempt.processLive !== true,
    noCurrentLease: !report.matchingAttempts.some((row) => row.attemptId !== String(attemptId) && !row.finishedAt),
    noUnresolvedClaim: !matchingAttempt || Boolean(matchingAttempt.finishedAt) || Boolean(matchingAttempt.outcome),
    noUnpushedCommit: matchingBranch ? matchingBranch.pushedToOrigin === true : true,
    noDirtyFiles: matchingWorktree ? matchingWorktree.dirty === false : true,
    noLinkedOpenPr: report.linkedOpenPullRequests.length === 0,
    identityBelongsToTerminalAttempt: Boolean(matchingAttempt) && Boolean(matchingAttempt.finishedAt || matchingAttempt.outcome),
  });

  if (!precondition.allowed) {
    return { executed: false, reason: 'guarded-cleanup-precondition-failed', failedFacts: precondition.failedFacts, report };
  }
  if (!matchingWorktree || !matchingBranch) {
    return { executed: false, reason: 'exact-branch-or-worktree-not-found', report };
  }

  const removeResult = runGit(['worktree', 'remove', worktree], localRepoPath);
  if (!removeResult.ok) {
    return { executed: false, reason: 'worktree-remove-failed', error: removeResult.error, report };
  }
  const deleteResult = runGit(['branch', '-d', branch], localRepoPath);
  if (!deleteResult.ok) {
    return { executed: false, reason: 'branch-delete-failed', error: deleteResult.error, worktreeRemoved: true, report };
  }
  return { executed: true, worktreeRemoved: true, branchDeleted: true, report };
}

export async function main(argv = process.argv.slice(2)) {
  const config = loadAgentRunnerConfig({ argv, env: process.env });
  const args = parseArgs(stripConfigArgs(argv));
  if (args.help) {
    printHelp();
    return 0;
  }
  if (config.projectId !== args.project) {
    console.log(JSON.stringify({ blocked: true, reason: 'project-mismatch', requested: args.project, configured: config.projectId, message: 'The loaded agent-runner config does not match --project. Pass the correct --config, or the correct AGENT_RUNNER_CONFIG, for this project before reconciling.' }, null, 2));
    return 1;
  }
  const dbPath = config.stateDbPath || defaultRunnerStateDbPath(config.outputDir);

  if (args.execute) {
    const result = await executeGuardedWorkspaceCleanup({
      repo: config.githubRepo, issueNumber: args.issue, attemptId: args.attemptId, branch: args.branch,
      worktree: args.worktree, dbPath, localRepoPath: config.localRepoPath,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.executed ? 0 : 1;
  }

  const report = await collectWorkspaceReconciliationReport({
    repo: config.githubRepo, issueNumber: args.issue, dbPath, localRepoPath: config.localRepoPath,
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
