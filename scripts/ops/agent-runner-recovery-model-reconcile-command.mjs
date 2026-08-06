#!/usr/bin/env node

/**
 * Bounded non-root operator command for historical `recovery_attempts.model`
 * reconciliation (#148). Thin CLI wiring only -- all repair policy lives in
 * `reconcileRecoveryAttemptModel()` (`agent-runner-recovery-model-
 * reconciliation.mjs`); this module's only job is: refuse root before any
 * I/O, validate/bound every input, wire real GitHub/state-store/filesystem
 * evidence, and emit bounded, redacted JSON output with fixed exit codes.
 *
 * Every input is supplied explicitly by the operator on the command line --
 * the scheduler/service is never consulted for implicit attempt selection,
 * and this command never claims, resumes, starts, or dispatches anything.
 *
 * Output is a fixed, bounded shape: `ok`, `code` (one of
 * `RECOVERY_MODEL_RECONCILIATION_FAILURE_CODES`, or a small set of
 * command-level codes below), `attemptId`, and (only on success) `model`/
 * `bindingDigest`. It never includes a session id, restricted-handle path,
 * raw handle JSON, prompts, provider output, credentials, environment
 * values, or unrestricted logs -- and top-level catches map every
 * unexpected internal failure to the fixed `internal-error` code, never
 * `error.message`.
 *
 * The database and restricted-recovery-root paths are always explicit
 * operator input (`--state-db`, `--repo-root`, optionally `--output-dir`):
 * this repairs one exact historical attempt and must never silently select
 * the live/default database or restricted directory from mutable process
 * environment defaults.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openRunnerStateStore } from './claude-runner-state.mjs';
import { readRestrictedRecoveryHandle, verifyPreservedWorktree } from './claude-runner-recovery-adapter.mjs';
import { isValidGitBranchName } from './agent-runner-dispatch-authority.mjs';
import { isSupportedModelId } from './claude-runner.mjs';
import { listAllPullRequests } from './claude-runner-cron.mjs';
import { reconcileRecoveryAttemptModel } from './agent-runner-recovery-model-reconciliation.mjs';

export const EXIT_OK = 0;
export const EXIT_RECONCILIATION_FAILED = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_ROOT_FORBIDDEN = 3;
export const EXIT_INTERNAL_ERROR = 4;

const REQUIRED_OPTIONS = Object.freeze([
  '--attempt-id', '--repo', '--agent', '--harness', '--model', '--branch', '--worktree',
  '--manager-revision', '--manager-fingerprint', '--manager-body-digest', '--repo-root',
]);
const OPTIONAL_OPTIONS = Object.freeze(['--output-dir', '--state-db']);
const KNOWN_OPTIONS = new Set([...REQUIRED_OPTIONS, ...OPTIONAL_OPTIONS]);

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]){0,99}\/[A-Za-z0-9](?:[A-Za-z0-9._-]){0,99}$/;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:#/-]){0,299}$/;
const AGENT_HARNESS_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MANAGER_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const PATH_PATTERN_MAX_LENGTH = 4096;

class CommandUsageError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CommandUsageError';
  }
}

/**
 * Reject any token that looks like an option (`--foo`) before I/O:
 * duplicated options, unknown options, and an option immediately followed
 * by another option (an ambiguous/missing value) must all fail closed at
 * parse time -- never silently take the last occurrence, the wrong value,
 * or a value that was actually meant as the next flag.
 */
function assertWellFormedArgv(argv) {
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new CommandUsageError(`unexpected positional argument: ${token}`);
    if (!KNOWN_OPTIONS.has(token)) throw new CommandUsageError(`unknown option: ${token}`);
    if (seen.has(token)) throw new CommandUsageError(`duplicate option: ${token}`);
    seen.add(token);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CommandUsageError(`${token} requires a value`);
    index += 1;
  }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function requiredOption(argv, name) {
  const value = optionValue(argv, name);
  if (value === undefined) throw new CommandUsageError(`${name} is required`);
  return value;
}

function boundedPath(value, name) {
  if (typeof value !== 'string' || !value || value.length > PATH_PATTERN_MAX_LENGTH || value.includes('\0')) {
    throw new CommandUsageError(`${name} is invalid`);
  }
  return resolve(value);
}

function matchOrThrow(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new CommandUsageError(`${name} is invalid`);
  return value;
}

/**
 * Validate and bound every command input before any I/O (config read, SQLite
 * open, GitHub contact, or restricted-path access) is attempted -- every
 * required field is pattern-checked, unknown/duplicate/malformed options
 * are rejected up front, and the database/restricted-root inputs are never
 * defaulted from live/mutable scheduler environment variables. Model
 * vocabulary membership is exact and case-sensitive (`isSupportedModelId`):
 * a differently-cased or trimmed alias is never normalized into validity.
 */
export function parseRecoveryModelReconcileArgs(argv = []) {
  assertWellFormedArgv(argv);

  const attemptId = matchOrThrow(requiredOption(argv, '--attempt-id'), ATTEMPT_ID_PATTERN, '--attempt-id');
  const repo = matchOrThrow(requiredOption(argv, '--repo'), REPO_PATTERN, '--repo');
  const agent = matchOrThrow(requiredOption(argv, '--agent'), AGENT_HARNESS_PATTERN, '--agent');
  const harness = matchOrThrow(requiredOption(argv, '--harness'), AGENT_HARNESS_PATTERN, '--harness');
  const model = requiredOption(argv, '--model');
  if (!isSupportedModelId(model)) throw new CommandUsageError('--model is not an exact supported model identifier');
  const branch = requiredOption(argv, '--branch');
  if (!isValidGitBranchName(branch) || branch.length > 200) throw new CommandUsageError('--branch is invalid');
  const worktree = matchOrThrow(requiredOption(argv, '--worktree'), WORKTREE_NAME_PATTERN, '--worktree');
  const managerRevision = matchOrThrow(requiredOption(argv, '--manager-revision'), MANAGER_REVISION_PATTERN, '--manager-revision');
  const managerFingerprint = matchOrThrow(requiredOption(argv, '--manager-fingerprint'), SHA256_DIGEST_PATTERN, '--manager-fingerprint');
  const managerBodyDigest = matchOrThrow(requiredOption(argv, '--manager-body-digest'), SHA256_DIGEST_PATTERN, '--manager-body-digest');
  const repoRoot = boundedPath(requiredOption(argv, '--repo-root'), '--repo-root');
  // Explicit-only: `--output-dir`/`--state-db` are never defaulted from
  // `process.env` -- an operator repairing one exact historical attempt
  // must name its exact database and restricted-recovery root, never
  // silently reuse whatever a live scheduler process happens to be
  // configured with.
  const outputDir = boundedPath(requiredOption(argv, '--output-dir'), '--output-dir');
  const stateDbPath = boundedPath(requiredOption(argv, '--state-db'), '--state-db');

  return Object.freeze({
    attemptId, repo, agent, harness, model, branch, worktree,
    managerRevision, managerFingerprint, managerBodyDigest,
    repoRoot, outputDir, stateDbPath,
  });
}

function defaultGhRunner(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isNotFoundError(error) {
  const text = `${error?.stderr || ''} ${error?.message || ''}`;
  return /HTTP 404/.test(text) || /Not Found \(HTTP 404\)/.test(text);
}

/**
 * `false` only when the exact branch is confirmed absent from the remote
 * (a real GitHub 404, and the success path returns exactly the requested
 * branch name); every other outcome -- found, empty, mismatched, malformed,
 * partial, rejected, rate-limited, or any other ambiguous/network failure
 * -- must never be read as "ruled out" (#148: never claim the SQLite lock,
 * or a missing/ambiguous signal, proves GitHub publication is absent).
 */
function remoteBranchPublished(repo, branch, ghRunner) {
  let raw;
  try {
    raw = ghRunner(['api', `repos/${repo}/branches/${encodeURIComponent(branch)}`, '--jq', '.name']);
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
  if (String(raw || '').trim() !== branch) {
    throw new Error('branch API returned unexpected output');
  }
  return true;
}

/**
 * `false` only when a real, exhaustively-paginated (`listAllPullRequests`)
 * read of every PR (any state) for the repository confirms none targets
 * this exact branch. A thrown/malformed/partial read propagates rather than
 * being treated as "no PR exists".
 */
function remotePrPublished(repo, branch, ghRunner, listAllPullRequestsFn) {
  const pullRequests = listAllPullRequestsFn(repo, ghRunner);
  return pullRequests.some((pr) => pr.headRefName === branch);
}

export function runRecoveryModelReconcileCommand({
  argv = process.argv.slice(2),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  ghRunner = defaultGhRunner,
  openStore = openRunnerStateStore,
  restrictedHandleReader = readRestrictedRecoveryHandle,
  worktreeVerifier = verifyPreservedWorktree,
  gitRunner,
  listAllPullRequestsFn = listAllPullRequests,
} = {}) {
  // Refused before any config read, SQLite open, GitHub contact, or
  // restricted-path access -- the very first thing this command does.
  if (uid === 0) {
    return { exitCode: EXIT_ROOT_FORBIDDEN, output: { ok: false, code: 'root-execution-forbidden' } };
  }

  let options;
  try {
    options = parseRecoveryModelReconcileArgs(argv);
  } catch {
    return { exitCode: EXIT_USAGE_ERROR, output: { ok: false, code: 'usage-error' } };
  }

  let store = null;
  try {
    store = openStore(options.stateDbPath);
    const outcome = reconcileRecoveryAttemptModel({
      attemptId: options.attemptId,
      store,
      outputDir: options.outputDir,
      repoRoot: options.repoRoot,
      expectedRepo: options.repo,
      expectedAgent: options.agent,
      expectedHarness: options.harness,
      expectedModel: options.model,
      expectedBranch: options.branch,
      expectedWorktreeName: options.worktree,
      expectedManagerRevision: options.managerRevision,
      expectedManagerFingerprint: options.managerFingerprint,
      expectedManagerBodyDigest: options.managerBodyDigest,
      remoteBranchPublishedProvider: () => remoteBranchPublished(options.repo, options.branch, ghRunner),
      remotePrPublishedProvider: () => remotePrPublished(options.repo, options.branch, ghRunner, listAllPullRequestsFn),
      restrictedHandleReader,
      worktreeVerifier,
      gitRunner,
    });
    return { exitCode: outcome.ok ? EXIT_OK : EXIT_RECONCILIATION_FAILED, output: outcome };
  } catch {
    // Every internal failure -- a thrown GitHub read, a store error, an
    // unexpected exception anywhere in the guarded path -- maps to this one
    // fixed code. `error.message` is never included: it could carry a raw
    // path, provider response fragment, or other unrestricted detail.
    return { exitCode: EXIT_INTERNAL_ERROR, output: { ok: false, code: 'internal-error' } };
  } finally {
    if (store) {
      try { store.close(); } catch { /* best-effort resource cleanup */ }
    }
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const { exitCode, output } = runRecoveryModelReconcileCommand();
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}
