#!/usr/bin/env node

// #252 (AUTONOMY.CONTROL.EVIDENCE.1): a bounded, positive-allowlisted
// projection of the exact Dell-local facts the #225/#234 Execution Manager
// needs before it can safely issue source-activation authority. This module
// never authorises activation, never mutates the checkout/scheduler/source
// state, and never publishes anything beyond the fixed field list below --
// no raw git/systemd output, no env contents, no paths, no credentials.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parseCronLock, processIsAlive } from './agent-runner-cron-lock.mjs';
import { REPOSITORY_ROOT, resolveImplementationLockPath } from './agent-runner-source-activation.mjs';
import {
  SOURCE_ACTIVATION_CONTROL_ISSUE_ENV,
  SOURCE_ACTIVATION_REPOSITORY,
  fetchSourceActivationComments,
  resolveSourceActivationGithubAuthEnv,
  sourceActivationEnabled,
} from './agent-runner-source-activation-authority.mjs';

export const CONTROL_EVIDENCE_MARKER = '<!-- agent-runner:control-evidence:v1 -->';
export const CONTROL_EVIDENCE_SCHEMA_VERSION = 'agent-runner-control-evidence/v1';
export const CONTROL_EVIDENCE_ISSUE_ENV = 'AGENT_RUNNER_CONTROL_EVIDENCE_ISSUE';
export const CONTROL_EVIDENCE_GENERIC_TIMER_UNIT = 'agent-runner-implementation.timer';
export const CONTROL_EVIDENCE_LEGACY_TIMER_UNIT = 'agent-runner-modelspend.timer';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const CONTROL_ISSUE_PATTERN = /^[1-9][0-9]{0,9}$/;

export const CONTROL_EVIDENCE_TIMER_STATES = Object.freeze([
  'enabled-active',
  'enabled-inactive',
  'disabled',
  'unknown',
]);

export const CONTROL_EVIDENCE_READINESS_REASONS = Object.freeze([
  'ready',
  'not-ready-repository-mismatch',
  'not-ready-branch-mismatch',
  'not-ready-head-unavailable',
  'not-ready-dirty',
  'not-ready-lock-ambiguous',
  'not-ready-lock-active',
  'not-ready-timer-topology-unknown',
  'not-ready-timer-topology',
  'not-ready-policy-unknown',
]);

export class ControlEvidenceError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.name = 'ControlEvidenceError';
    this.code = 'AGENT_RUNNER_CONTROL_EVIDENCE_ERROR';
    this.reason = reason;
  }
}

function fail(reason, message) {
  throw new ControlEvidenceError(reason, message);
}

function defaultRunGit(args, { cwd }) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout || ''),
  };
}

function gitText(runGit, args, { cwd }) {
  const result = runGit(args, { cwd });
  if (result?.status !== 0) return null;
  const text = String(result.stdout || '').trim();
  return text || null;
}

function verifyRepositoryIdentity({ repositoryRoot, runGit, realpath }) {
  let canonicalRoot;
  try {
    canonicalRoot = realpath(repositoryRoot);
  } catch {
    return false;
  }
  const topLevel = gitText(runGit, ['rev-parse', '--show-toplevel'], { cwd: repositoryRoot });
  if (!topLevel) return false;
  try {
    return realpath(topLevel) === canonicalRoot;
  } catch {
    return false;
  }
}

function readBranch({ repositoryRoot, runGit }) {
  const branch = gitText(runGit, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repositoryRoot });
  return branch && BRANCH_PATTERN.test(branch) ? branch : null;
}

function readHead({ repositoryRoot, runGit }) {
  const head = gitText(runGit, ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: repositoryRoot });
  const lowered = head ? head.toLowerCase() : null;
  return lowered && FULL_SHA_PATTERN.test(lowered) ? lowered : null;
}

/** `null` (unknown) is never treated as clean by any caller in this module. */
function readClean({ repositoryRoot, runGit }) {
  const result = runGit(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot });
  if (result?.status !== 0) return null;
  return String(result.stdout || '').trim() === '';
}

/**
 * Quiescent means "no worker currently owns the global implementation
 * lock" -- lock absent, or present with an owner PID that is proven dead.
 * A lock file that cannot be read or parsed is ambiguous, not quiescent,
 * and never silently treated as idle.
 */
function readImplementationLockState({ env, exists, readFile, isAlive }) {
  const lockPath = resolveImplementationLockPath(env);
  if (!exists(lockPath)) return { quiescent: true, ambiguous: false };
  let contents;
  try {
    contents = readFile(lockPath, 'utf8');
  } catch {
    return { quiescent: false, ambiguous: true };
  }
  const parsed = parseCronLock(contents);
  if (!parsed) return { quiescent: false, ambiguous: true };
  let alive;
  try {
    alive = isAlive(parsed.pid);
  } catch {
    return { quiescent: false, ambiguous: true };
  }
  return { quiescent: !alive, ambiguous: false };
}

/** `true`/`false`/`null` (unknown) purely from a bounded process exit code, never from captured output. */
function boundedTriState(result, trueExits, falseExits) {
  if (!result || result.error) return null;
  if (trueExits.includes(result.status)) return true;
  if (falseExits.includes(result.status)) return false;
  return null;
}

function readTimerState(unit, spawn) {
  const enabledResult = spawn('systemctl', ['--user', 'is-enabled', '--quiet', unit], { encoding: 'utf8' });
  const activeResult = spawn('systemctl', ['--user', 'is-active', '--quiet', unit], { encoding: 'utf8' });
  const enabled = boundedTriState(enabledResult, [0], [1, 3, 4]);
  const active = boundedTriState(activeResult, [0], [1, 3, 4]);
  if (enabled === null || active === null) return 'unknown';
  if (enabled && active) return 'enabled-active';
  if (!enabled && !active) return 'disabled';
  return 'enabled-inactive';
}

function boundedControlIssue(env) {
  const raw = String(env[SOURCE_ACTIVATION_CONTROL_ISSUE_ENV] || '').trim();
  return CONTROL_ISSUE_PATTERN.test(raw) ? Number(raw) : null;
}

/**
 * Gathers every Dell-local proposition the evidence contract needs. Every
 * dependency is injectable so tests never touch real git/systemd/filesystem
 * state; the exported default is what production uses.
 */
export function collectControlEvidenceFacts({
  env = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  runGit = defaultRunGit,
  realpath = realpathSync,
  exists = existsSync,
  readFile = readFileSync,
  isAlive = processIsAlive,
  spawn = spawnSync,
  now = () => new Date().toISOString(),
} = {}) {
  const repositoryVerified = verifyRepositoryIdentity({ repositoryRoot, runGit, realpath });
  const branch = readBranch({ repositoryRoot, runGit });
  const head = readHead({ repositoryRoot, runGit });
  const clean = readClean({ repositoryRoot, runGit });
  const lock = readImplementationLockState({ env, exists, readFile, isAlive });
  const genericTimerState = readTimerState(CONTROL_EVIDENCE_GENERIC_TIMER_UNIT, spawn);
  const legacyTimerState = readTimerState(CONTROL_EVIDENCE_LEGACY_TIMER_UNIT, spawn);
  const enabled = sourceActivationEnabled(env);
  const controlIssue = boundedControlIssue(env);
  const policyKnown = !enabled || controlIssue !== null;

  return Object.freeze({
    recordedAt: now(),
    repositoryVerified,
    branch,
    head,
    clean,
    implementationQuiescent: lock.quiescent,
    lockAmbiguous: lock.ambiguous,
    sourceActivationEnabled: enabled,
    sourceActivationControlIssue: controlIssue,
    sourceActivationPolicyKnown: policyKnown,
    genericTimerState,
    legacyTimerState,
    legacyTimerDisabled: legacyTimerState === 'disabled',
    soleScheduler: genericTimerState === 'enabled-active' && legacyTimerState === 'disabled',
  });
}

/**
 * Pure, default-deny readiness decision. Every check is fail-closed: an
 * unknown or ambiguous proposition never resolves to `ready`, and exactly
 * one bounded reason code is returned so a caller can never mistake an
 * unproven state for a proven one (#252 requirement 7).
 */
export function evaluateControlEvidenceReadiness(facts) {
  if (!facts?.repositoryVerified) return 'not-ready-repository-mismatch';
  if (facts.branch !== 'main') return 'not-ready-branch-mismatch';
  if (!facts.head) return 'not-ready-head-unavailable';
  if (facts.clean !== true) return 'not-ready-dirty';
  if (facts.lockAmbiguous) return 'not-ready-lock-ambiguous';
  if (!facts.implementationQuiescent) return 'not-ready-lock-active';
  if (facts.genericTimerState === 'unknown' || facts.legacyTimerState === 'unknown') return 'not-ready-timer-topology-unknown';
  if (!facts.soleScheduler) return 'not-ready-timer-topology';
  if (!facts.sourceActivationPolicyKnown) return 'not-ready-policy-unknown';
  return 'ready';
}

/**
 * The complete, positively-allowlisted evidence projection. This is the
 * only function that decides what is GitHub-visible: every field is a
 * bounded primitive already proven above, nothing observed (raw git/systemd
 * output, env values, paths, prompts, provider output) can reach it.
 */
export function buildControlEvidence(facts) {
  const readinessCode = evaluateControlEvidenceReadiness(facts);
  return Object.freeze({
    schemaVersion: CONTROL_EVIDENCE_SCHEMA_VERSION,
    recordedAt: facts.recordedAt,
    repository: SOURCE_ACTIVATION_REPOSITORY,
    repositoryVerified: facts.repositoryVerified === true,
    branch: facts.branch === 'main' ? 'main' : null,
    headSha: facts.head,
    clean: facts.clean === true,
    implementationQuiescent: facts.implementationQuiescent === true,
    sourceActivationEnabled: facts.sourceActivationEnabled === true,
    sourceActivationControlIssue: facts.sourceActivationControlIssue,
    genericTimerState: facts.genericTimerState,
    legacyTimerDisabled: facts.legacyTimerDisabled === true,
    readinessCode,
    ready: readinessCode === 'ready',
  });
}

export function buildControlEvidenceCommentBody(evidence) {
  return [
    CONTROL_EVIDENCE_MARKER,
    '',
    '## Dell control-plane evidence',
    '',
    '```yaml',
    `schema_version: ${evidence.schemaVersion}`,
    `recorded_at: ${evidence.recordedAt}`,
    `repository: ${evidence.repository}`,
    `repository_verified: ${evidence.repositoryVerified}`,
    `branch: ${evidence.branch || 'unknown'}`,
    `head: ${evidence.headSha || 'unknown'}`,
    `clean: ${evidence.clean}`,
    `implementation_quiescent: ${evidence.implementationQuiescent}`,
    `source_activation_enabled: ${evidence.sourceActivationEnabled}`,
    `source_activation_control_issue: ${evidence.sourceActivationControlIssue ?? 'unset'}`,
    `generic_timer_state: ${evidence.genericTimerState}`,
    `legacy_timer_disabled: ${evidence.legacyTimerDisabled}`,
    `readiness: ${evidence.readinessCode}`,
    '```',
    '',
    'This is a read-only Dell control-plane evidence projection (#252). It never authorises source activation and never mutates the checkout, scheduler, source-activation state or issue claims.',
  ].join('\n');
}

export function resolveControlEvidenceIssue(env = process.env) {
  const raw = String(env[CONTROL_EVIDENCE_ISSUE_ENV] || '').trim();
  return CONTROL_ISSUE_PATTERN.test(raw) ? Number(raw) : null;
}

function controlEvidenceMarkedComments(comments) {
  return comments
    .filter((comment) => String(comment?.body || '').includes(CONTROL_EVIDENCE_MARKER))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Publishes/updates the one dedicated control-evidence comment on the
 * configured issue, reusing the existing bounded GitHub auth/list plumbing
 * (`fetchSourceActivationComments` / `resolveSourceActivationGithubAuthEnv`)
 * rather than a second network client. Identical evidence is a no-op;
 * changed evidence updates the same comment in place; nothing is ever
 * appended as a fresh comment once one exists.
 */
export function publishControlEvidence({
  issueNumber,
  evidence,
  env = process.env,
  fetchComments = fetchSourceActivationComments,
  exec = execFileSync,
} = {}) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    fail('control-evidence-issue-invalid', 'A positive control-evidence issue number is required.');
  }
  const body = buildControlEvidenceCommentBody(evidence);
  const comments = fetchComments(issueNumber, { env });
  const marked = controlEvidenceMarkedComments(comments);
  if (marked.length > 1) {
    fail('control-evidence-comment-ambiguous', 'More than one control-evidence comment exists on the configured issue.');
  }
  const existing = marked[0] || null;
  if (existing && existing.body === body) {
    return { action: 'deduped', commentId: Number(existing.id) || null };
  }

  const authEnv = resolveSourceActivationGithubAuthEnv(env);
  if (!authEnv) fail('control-evidence-github-auth-unavailable', 'GitHub control-plane authentication is unavailable.');

  if (existing) {
    const id = Number(existing.id);
    try {
      exec(
        'gh',
        ['api', '--method', 'PATCH', `/repos/${SOURCE_ACTIVATION_REPOSITORY}/issues/comments/${id}`, '-f', `body=${body}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: authEnv },
      );
    } catch {
      fail('control-evidence-github-write-failed', 'Updating the control-evidence comment failed.');
    }
    return { action: 'updated', commentId: id };
  }

  let output;
  try {
    output = exec(
      'gh',
      ['api', '--method', 'POST', `/repos/${SOURCE_ACTIVATION_REPOSITORY}/issues/${issueNumber}/comments`, '-f', `body=${body}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: authEnv },
    );
  } catch {
    fail('control-evidence-github-write-failed', 'Publishing the control-evidence comment failed.');
  }
  let parsed;
  try {
    parsed = JSON.parse(output || '{}');
  } catch {
    fail('control-evidence-github-response-invalid', 'GitHub returned an invalid control-evidence comment response.');
  }
  const commentId = Number(parsed?.id);
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    fail('control-evidence-github-response-invalid', 'GitHub did not return a valid control-evidence comment identity.');
  }
  return { action: 'created', commentId };
}

/**
 * Collects facts and, only when a control-evidence issue is configured,
 * publishes/dedupes the projection. Publisher failure never mutates
 * anything: `collectControlEvidenceFacts()` / `buildControlEvidence()` have
 * already completed by the time any GitHub write is attempted, and a write
 * failure surfaces as a thrown `ControlEvidenceError` with no local or
 * remote side effect beyond the attempted (and rejected) comment write.
 */
export async function runControlEvidence({
  env = process.env,
  collectFacts = collectControlEvidenceFacts,
  publish = publishControlEvidence,
} = {}) {
  const facts = collectFacts({ env });
  const evidence = buildControlEvidence(facts);
  const issueNumber = resolveControlEvidenceIssue(env);
  if (!issueNumber) {
    return { evidence, published: false, publishAction: 'not-configured', publishedCommentId: null };
  }
  const result = publish({ issueNumber, evidence, env });
  return { evidence, published: true, publishAction: result.action, publishedCommentId: result.commentId };
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  try {
    const result = await runControlEvidence();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    const reason = error instanceof ControlEvidenceError ? error.reason : 'control-evidence-systemic-failure';
    console.error(JSON.stringify({ ok: false, reason }, null, 2));
    process.exitCode = 1;
  }
}
