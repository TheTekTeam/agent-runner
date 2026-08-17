#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireRecoverableCronLock } from './agent-runner-cron-lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, '../..');
export const IMPLEMENTATION_LOCK_ENV = 'AGENT_RUNNER_IMPLEMENTATION_LOCK';
export const SOURCE_ACTIVATION_EVIDENCE_DIR_ENV = 'AGENT_RUNNER_SOURCE_ACTIVATION_EVIDENCE_DIR';
export const SOURCE_ACTIVATION_SCHEMA_VERSION = 1;
const FULL_SHA = /^[0-9a-f]{40}$/i;

export class SourceActivationRefusal extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.name = 'SourceActivationRefusal';
    this.code = 'AGENT_RUNNER_SOURCE_ACTIVATION_REFUSED';
    this.reason = reason;
  }
}

function refuse(reason, message) {
  throw new SourceActivationRefusal(reason, message);
}

export function validateTargetSha(value) {
  const target = String(value || '').trim();
  if (!FULL_SHA.test(target)) {
    refuse('invalid-target-sha', 'Source activation requires exactly one full 40-character commit SHA.');
  }
  return target.toLowerCase();
}

export function parseActivationArgs(argv = []) {
  let target = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      if (target !== null || index + 1 >= argv.length) {
        refuse('invalid-arguments', 'Source activation requires exactly one --target value.');
      }
      target = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true, target: null };
    }
    refuse('unsupported-argument', `Unsupported source-activation argument: ${arg}`);
  }
  if (target === null) {
    refuse('missing-target', 'Source activation requires --target <40-hex-sha>.');
  }
  return { help: false, target: validateTargetSha(target) };
}

export function resolveImplementationLockPath(env = process.env) {
  return env[IMPLEMENTATION_LOCK_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/implementation-recurrence.lock');
}

export function resolveSourceActivationEvidenceDir(env = process.env) {
  return env[SOURCE_ACTIVATION_EVIDENCE_DIR_ENV]
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/source-activation');
}

function boundedReason(error) {
  if (error instanceof SourceActivationRefusal) return error.reason;
  if (error?.code === 'AGENT_RUNNER_LOCKED') return 'implementation-lock-unavailable';
  return 'source-activation-systemic-failure';
}

function defaultRunGit(args, { cwd }) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function gitText(runGit, args, { cwd, failureReason }) {
  const result = runGit(args, { cwd });
  if (result?.status !== 0) {
    refuse(failureReason, `Git command failed during source activation (${failureReason}).`);
  }
  return String(result.stdout || '').trim();
}

function normalizePath(realpath, value, reason) {
  try {
    return realpath(value);
  } catch {
    refuse(reason, `Source activation could not prove canonical repository identity (${reason}).`);
  }
}

export function resolveCanonicalRepositoryRoot({
  env = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  realpath = realpathSync,
} = {}) {
  const sourceRoot = normalizePath(realpath, repositoryRoot, 'canonical-repository-unavailable');
  if (env.AGENT_RUNNER_HOME) {
    const configured = normalizePath(realpath, env.AGENT_RUNNER_HOME, 'configured-agent-runner-home-unavailable');
    if (configured !== sourceRoot) {
      refuse(
        'configured-agent-runner-home-mismatch',
        'AGENT_RUNNER_HOME does not identify the repository containing the source-activation controller.',
      );
    }
  }
  return sourceRoot;
}

function assertNonRoot(getuid = () => process.getuid?.()) {
  const uid = getuid();
  if (uid === 0) refuse('root-execution-forbidden', 'Source activation must not run as root.');
}

function assertRepositoryIdentity({ repoRoot, runGit, realpath = realpathSync }) {
  const topLevel = gitText(runGit, ['rev-parse', '--show-toplevel'], {
    cwd: repoRoot,
    failureReason: 'not-a-git-worktree',
  });
  if (normalizePath(realpath, topLevel, 'git-worktree-identity-unavailable') !== repoRoot) {
    refuse('canonical-repository-mismatch', 'Git worktree identity does not match the canonical Agent Runner repository.');
  }
}

function assertMainBranch({ repoRoot, runGit }) {
  const branch = gitText(runGit, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: repoRoot,
    failureReason: 'branch-unavailable',
  });
  if (branch !== 'main') refuse('wrong-branch', 'Source activation requires the canonical checkout to be on main.');
  return branch;
}

function assertClean({ repoRoot, runGit, reason = 'dirty-checkout' }) {
  const status = gitText(runGit, ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    failureReason: 'status-check-failed',
  });
  if (status !== '') refuse(reason, 'Source activation requires a completely clean checkout, including untracked files.');
  return true;
}

function readHead({ repoRoot, runGit, failureReason = 'head-unavailable' }) {
  const head = gitText(runGit, ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: repoRoot,
    failureReason,
  }).toLowerCase();
  if (!FULL_SHA.test(head)) refuse(failureReason, 'Git returned a non-canonical HEAD during source activation.');
  return head;
}

function assertOriginContract({ repoRoot, runGit }) {
  const result = runGit(['remote', 'get-url', 'origin'], { cwd: repoRoot });
  if (result?.status !== 0 || String(result.stdout || '').trim() === '') {
    refuse('origin-remote-unavailable', 'The canonical repository origin remote is unavailable.');
  }
}

function fetchOriginMain({ repoRoot, runGit }) {
  const fetch = runGit(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'], { cwd: repoRoot });
  if (fetch?.status !== 0) refuse('origin-fetch-failed', 'Fetching canonical origin/main failed.');
  const fetched = gitText(runGit, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], {
    cwd: repoRoot,
    failureReason: 'origin-main-unavailable',
  }).toLowerCase();
  if (!FULL_SHA.test(fetched)) refuse('origin-main-unavailable', 'Fetched origin/main did not resolve to a full commit SHA.');
  return fetched;
}

function assertFastForwardEligible({ repoRoot, runGit, oldHead, target }) {
  const result = runGit(['merge-base', '--is-ancestor', oldHead, target], { cwd: repoRoot });
  if (result?.status === 0) return true;
  if (result?.status === 1) {
    refuse('non-fast-forward-target', 'The current canonical HEAD is not an ancestor of the authorised target.');
  }
  refuse('merge-base-failed', 'Git could not determine fast-forward eligibility.');
}

function defaultWriteEvidence(record, { env = process.env, now = () => new Date().toISOString(), pid = process.pid } = {}) {
  const evidenceDir = resolveSourceActivationEvidenceDir(env);
  mkdirSync(evidenceDir, { recursive: true });
  const stamp = now().replace(/[:.]/g, '-');
  const path = resolve(evidenceDir, `activation-${stamp}-${pid}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function lockReleaseSucceeded(lockPath, ownedContents, { exists = existsSync, readFile = readFileSync } = {}) {
  if (!exists(lockPath)) return true;
  try {
    return readFile(lockPath, 'utf8') !== ownedContents;
  } catch {
    return true;
  }
}

function evidenceBase({ target, recordedAt }) {
  return {
    schemaVersion: SOURCE_ACTIVATION_SCHEMA_VERSION,
    recordedAt,
    oldHead: null,
    requestedTarget: target,
    fetchedOriginMain: null,
    finalHead: null,
    branch: null,
    cleanBefore: null,
    cleanAfter: null,
    fastForwardEligible: null,
    result: 'refused',
    refusalReason: null,
    lockAcquired: false,
    lockReleased: false,
  };
}

export async function activateAgentRunnerSource({
  target,
  env = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  runGit = defaultRunGit,
  acquireLock = acquireRecoverableCronLock,
  realpath = realpathSync,
  getuid = () => process.getuid?.(),
  now = () => new Date().toISOString(),
  writeEvidence = defaultWriteEvidence,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  assertNonRoot(getuid);
  const exactTarget = validateTargetSha(target);
  const repoRoot = resolveCanonicalRepositoryRoot({ env, repositoryRoot, realpath });
  const recordedAt = now();
  const evidence = evidenceBase({ target: exactTarget, recordedAt });
  const lockPath = resolveImplementationLockPath(env);
  let release = null;
  let ownedLockContents = null;
  let evidencePath = null;

  const persist = () => {
    evidencePath = writeEvidence({ ...evidence }, { env, now: () => recordedAt });
  };

  try {
    try {
      release = acquireLock(lockPath);
      evidence.lockAcquired = true;
      try { ownedLockContents = readFile(lockPath, 'utf8'); } catch { ownedLockContents = null; }
    } catch (error) {
      evidence.refusalReason = boundedReason(error);
      persist();
      throw error;
    }

    assertRepositoryIdentity({ repoRoot, runGit, realpath });
    evidence.branch = assertMainBranch({ repoRoot, runGit });
    evidence.cleanBefore = assertClean({ repoRoot, runGit });
    evidence.oldHead = readHead({ repoRoot, runGit });
    assertOriginContract({ repoRoot, runGit });
    evidence.fetchedOriginMain = fetchOriginMain({ repoRoot, runGit });

    if (evidence.fetchedOriginMain !== exactTarget) {
      refuse('target-origin-mismatch', 'The authorised target does not exactly equal fetched origin/main.');
    }

    evidence.fastForwardEligible = assertFastForwardEligible({
      repoRoot,
      runGit,
      oldHead: evidence.oldHead,
      target: exactTarget,
    });

    if (evidence.oldHead === exactTarget) {
      evidence.result = 'already-active';
    } else {
      const merge = runGit(['merge', '--ff-only', '--no-edit', exactTarget], { cwd: repoRoot });
      if (merge?.status !== 0) refuse('fast-forward-merge-failed', 'Exact fast-forward activation failed.');
      evidence.result = 'activated';
    }

    evidence.finalHead = readHead({ repoRoot, runGit, failureReason: 'final-head-unavailable' });
    if (evidence.finalHead !== exactTarget) refuse('final-head-mismatch', 'Post-activation HEAD does not equal the authorised target.');
    evidence.branch = assertMainBranch({ repoRoot, runGit });
    evidence.cleanAfter = assertClean({ repoRoot, runGit, reason: 'dirty-after-activation' });
    evidence.refusalReason = null;

    // Persist the verified transaction while this process still owns the shared
    // implementation lock. The same bounded record is finalized with the
    // release outcome immediately after owned-lock cleanup.
    persist();
  } catch (error) {
    if (evidence.result === 'activated' || evidence.result === 'already-active') {
      evidence.result = 'verification-failed';
    } else {
      evidence.result = 'refused';
    }
    if (evidence.refusalReason === null) {
      evidence.refusalReason = boundedReason(error);
      try { persist(); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    if (release) {
      try {
        release();
        evidence.lockReleased = ownedLockContents === null
          ? !exists(lockPath)
          : lockReleaseSucceeded(lockPath, ownedLockContents, { exists, readFile });
      } catch {
        evidence.lockReleased = false;
      }
      try { persist(); } catch { /* caller already has the transaction result/error */ }
    }
  }

  if (!evidence.lockReleased) {
    const error = new Error('Source activation completed but the owned implementation lock could not be proven released.');
    error.code = 'AGENT_RUNNER_SOURCE_ACTIVATION_LOCK_RELEASE_FAILED';
    throw error;
  }

  return {
    ok: true,
    result: evidence.result,
    oldHead: evidence.oldHead,
    target: exactTarget,
    finalHead: evidence.finalHead,
    fastForwardEligible: evidence.fastForwardEligible,
    evidenceRecorded: Boolean(evidencePath),
  };
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href
  : false;

if (invokedAsScript) {
  try {
    const parsed = parseActivationArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log('Usage: node scripts/ops/agent-runner-source-activation.mjs --target <40-hex-sha>');
    } else {
      const result = await activateAgentRunnerSource({ target: parsed.target });
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    const reason = boundedReason(error);
    console.error(JSON.stringify({ ok: false, reason }));
    process.exitCode = error instanceof SourceActivationRefusal || error?.code === 'AGENT_RUNNER_LOCKED' ? 3 : 1;
  }
}
