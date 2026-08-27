#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveDispatchAuthority } from './agent-runner-dispatch-authority.mjs';
import { parseLiveWorkerRegistry } from './agent-runner-live-worker-routing.mjs';
import {
  managerAuthorityApprovesAgent,
  resolveCurrentManagerAuthority,
} from './agent-runner-manager-authority.mjs';
import {
  acceptClaudeWorkerQualificationResult,
  buildClaudeWorkerQualificationRequest,
  CLAUDE_WORKER_QUALIFICATION_AGENT,
  CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE,
  CLAUDE_WORKER_QUALIFICATION_REPOSITORY,
  CLAUDE_WORKER_QUALIFICATION_TARGET_NODE,
} from './agent-runner-claude-worker-qualification.mjs';
import { executeClaudeWorkerQualificationRequest } from './agent-runner-claude-worker-qualification-executor.mjs';

const COMMAND_SCHEMA_VERSION = 1;
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_MANAGER_COMMENTS = 256;
const MAX_COMMENT_BYTES = 128 * 1024;
const AUTHORITY_KEY = /^manager-preflight:[A-Za-z0-9][A-Za-z0-9._:/-]{2,160}:sha256:[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REPOSITORY_ENV = 'AGENT_RUNNER_CLAUDE_QUALIFICATION_SOURCE_REPOSITORY';
const WORKTREE_ROOT_ENV = 'AGENT_RUNNER_CLAUDE_QUALIFICATION_WORKTREE_ROOT';
const STATE_ROOT_ENV = 'AGENT_RUNNER_CLAUDE_QUALIFICATION_STATE_ROOT';
const CONTROLLER_REPOSITORY_ENV = 'AGENT_RUNNER_CLAUDE_QUALIFICATION_CONTROLLER_REPOSITORY';
const NODE_ID_ENV = 'AGENT_RUNNER_NODE_ID';
const CONTROLLER_NODE_ID_ENV = 'AGENT_RUNNER_CONTROLLER_NODE_ID';
const FIXED_CLAUDE_PATH = '/usr/bin/claude';
const FIXED_WORKTREE_ID = 'claude-qualification-398-z790';
const FIXED_LANE_ID = 'qualification-claude-z790';

export class ClaudeWorkerQualificationCommandError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ClaudeWorkerQualificationCommandError';
    this.code = code;
  }
}

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function requiredEnv(env, name) {
  const value = String(env?.[name] || '').trim();
  if (!value) throw new ClaudeWorkerQualificationCommandError('machine-config-missing', `${name} is not configured`);
  return value;
}

function repositoryFromOrigin(value) {
  const raw = String(value || '').trim().replace(/\.git$/, '');
  const match = raw.match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i);
  return match?.[1] || null;
}

function git(args, { cwd, execFileSyncFn = execFileSync } = {}) {
  return String(execFileSyncFn('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024,
  }) || '').trim();
}

function normalizedManagerComments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MANAGER_COMMENTS) {
    throw new ClaudeWorkerQualificationCommandError('manager-comments-invalid');
  }
  return value.map((comment) => {
    if (!exactFields(comment, ['id', 'body', 'created_at', 'updated_at'])) {
      throw new ClaudeWorkerQualificationCommandError('manager-comment-field-set-invalid');
    }
    if (!Number.isSafeInteger(Number(comment.id)) || Number(comment.id) < 1) {
      throw new ClaudeWorkerQualificationCommandError('manager-comment-id-invalid');
    }
    const body = String(comment.body || '');
    if (Buffer.byteLength(body) > MAX_COMMENT_BYTES) {
      throw new ClaudeWorkerQualificationCommandError('manager-comment-too-large');
    }
    for (const field of ['created_at', 'updated_at']) {
      if (!Number.isFinite(Date.parse(comment[field]))) {
        throw new ClaudeWorkerQualificationCommandError('manager-comment-time-invalid');
      }
    }
    return Object.freeze({
      id: Number(comment.id),
      body,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    });
  });
}

function verifyExpectedAuthority({ comments, authorityKey, packetDigest }) {
  if (!AUTHORITY_KEY.test(String(authorityKey || ''))) {
    throw new ClaudeWorkerQualificationCommandError('manager-authority-key-invalid');
  }
  if (!DIGEST.test(String(packetDigest || ''))) {
    throw new ClaudeWorkerQualificationCommandError('manager-authority-packet-digest-invalid');
  }
  const resolvedAuthority = resolveCurrentManagerAuthority(comments);
  if (resolvedAuthority.allowed !== true || !resolvedAuthority.authority) {
    throw new ClaudeWorkerQualificationCommandError(resolvedAuthority.reason || 'manager-authority-unavailable');
  }
  const authority = resolvedAuthority.authority;
  if (authority.authorityKey !== authorityKey || authority.packetDigest !== packetDigest) {
    throw new ClaudeWorkerQualificationCommandError('manager-authority-not-current');
  }
  if (!managerAuthorityApprovesAgent(authority, CLAUDE_WORKER_QUALIFICATION_AGENT)) {
    throw new ClaudeWorkerQualificationCommandError('manager-authority-agent-mismatch');
  }
  if (authority.executionPhase !== 'implementation') {
    throw new ClaudeWorkerQualificationCommandError('manager-authority-phase-mismatch');
  }
  return authority;
}

function verifyDispatchAuthority({ authority, controllerRepositoryPath }) {
  const dispatch = resolveDispatchAuthority({
    preflight: authority.comment,
    legacyMetadata: {},
    argsRepo: CLAUDE_WORKER_QUALIFICATION_REPOSITORY,
    config: {
      githubRepo: CLAUDE_WORKER_QUALIFICATION_REPOSITORY,
      localRepoPath: controllerRepositoryPath,
    },
    runnerCheckout: controllerRepositoryPath,
  });
  if (!dispatch.ok) {
    throw new ClaudeWorkerQualificationCommandError(dispatch.failureReason || 'dispatch-authority-invalid');
  }
  if (
    dispatch.repository !== CLAUDE_WORKER_QUALIFICATION_REPOSITORY
    || dispatch.revision !== authority.revision
    || dispatch.fingerprint !== authority.fingerprint
  ) {
    throw new ClaudeWorkerQualificationCommandError('dispatch-authority-identity-mismatch');
  }
  return dispatch;
}

export function verifyClaudeQualificationControllerSource({
  controllerRepositoryPath,
  baseSha,
  execFileSyncFn = execFileSync,
} = {}) {
  const root = resolve(String(controllerRepositoryPath || ''));
  if (git(['branch', '--show-current'], { cwd: root, execFileSyncFn }) !== 'main') {
    throw new ClaudeWorkerQualificationCommandError('controller-source-not-main');
  }
  if (git(['rev-parse', 'HEAD'], { cwd: root, execFileSyncFn }) !== baseSha) {
    throw new ClaudeWorkerQualificationCommandError('controller-source-head-mismatch');
  }
  const status = String(execFileSyncFn('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024,
  }) || '');
  if (status !== '') throw new ClaudeWorkerQualificationCommandError('controller-source-dirty');
  if (repositoryFromOrigin(git(['remote', 'get-url', 'origin'], { cwd: root, execFileSyncFn })) !== CLAUDE_WORKER_QUALIFICATION_REPOSITORY) {
    throw new ClaudeWorkerQualificationCommandError('controller-source-repository-mismatch');
  }
  if (git(['rev-parse', `${baseSha}^{commit}`], { cwd: root, execFileSyncFn }) !== baseSha) {
    throw new ClaudeWorkerQualificationCommandError('controller-source-commit-unavailable');
  }
  return Object.freeze({ ok: true, baseSha });
}

export function buildClaudeWorkerQualificationCommandRequest({
  input,
  registry,
  controllerRepositoryPath,
  verifySourceFn = verifyClaudeQualificationControllerSource,
} = {}) {
  if (!exactFields(input, ['managerComments', 'authorityKey', 'packetDigest', 'requestedAt', 'expiresAt'])) {
    throw new ClaudeWorkerQualificationCommandError('build-request-field-set-invalid');
  }
  if (registry?.controllerNodeId !== CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE) {
    throw new ClaudeWorkerQualificationCommandError('controller-registry-mismatch');
  }
  const comments = normalizedManagerComments(input.managerComments);
  const authority = verifyExpectedAuthority({
    comments,
    authorityKey: input.authorityKey,
    packetDigest: input.packetDigest,
  });
  const dispatch = verifyDispatchAuthority({ authority, controllerRepositoryPath });
  verifySourceFn({ controllerRepositoryPath, baseSha: dispatch.baseCommit });

  const request = buildClaudeWorkerQualificationRequest({
    registry,
    authorityFingerprint: authority.fingerprint,
    baseSha: dispatch.baseCommit,
    branch: dispatch.branch,
    worktree: FIXED_WORKTREE_ID,
    laneId: FIXED_LANE_ID,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
  });
  return Object.freeze({
    authority: Object.freeze({
      authorityKey: authority.authorityKey,
      revision: authority.revision,
      fingerprint: authority.fingerprint,
      packetDigest: authority.packetDigest,
      commentId: authority.commentIdentity?.id || authority.comment?.id || null,
    }),
    request,
  });
}

export async function executeClaudeWorkerQualificationCommand({
  input,
  registry,
  env = process.env,
  executeFn = executeClaudeWorkerQualificationRequest,
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ClaudeWorkerQualificationCommandError('qualification-request-invalid');
  }
  const nodeId = requiredEnv(env, NODE_ID_ENV);
  if (nodeId !== CLAUDE_WORKER_QUALIFICATION_TARGET_NODE) {
    throw new ClaudeWorkerQualificationCommandError('worker-node-mismatch');
  }
  if (requiredEnv(env, CONTROLLER_NODE_ID_ENV) !== CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE) {
    throw new ClaudeWorkerQualificationCommandError('worker-controller-mismatch');
  }
  return executeFn({
    request: input,
    registry,
    executingNodeId: nodeId,
    sourceRepositoryPath: requiredEnv(env, SOURCE_REPOSITORY_ENV),
    worktreeRoot: requiredEnv(env, WORKTREE_ROOT_ENV),
    stateRoot: requiredEnv(env, STATE_ROOT_ENV),
    claudePath: FIXED_CLAUDE_PATH,
    env,
  });
}

export function acceptClaudeWorkerQualificationCommandResult({
  input,
  registry,
  controllerRepositoryPath,
  now = new Date(),
  verifySourceFn = verifyClaudeQualificationControllerSource,
} = {}) {
  if (!exactFields(input, ['managerComments', 'authorityKey', 'packetDigest', 'request', 'result'])) {
    throw new ClaudeWorkerQualificationCommandError('accept-field-set-invalid');
  }
  if (registry?.controllerNodeId !== CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE) {
    throw new ClaudeWorkerQualificationCommandError('controller-registry-mismatch');
  }
  const comments = normalizedManagerComments(input.managerComments);
  const authority = verifyExpectedAuthority({
    comments,
    authorityKey: input.authorityKey,
    packetDigest: input.packetDigest,
  });
  const dispatch = verifyDispatchAuthority({ authority, controllerRepositoryPath });
  if (
    input.request?.lease?.authorityFingerprint !== authority.fingerprint
    || input.request?.lease?.baseSha !== dispatch.baseCommit
    || input.request?.lease?.branch !== dispatch.branch
  ) {
    throw new ClaudeWorkerQualificationCommandError('request-manager-authority-mismatch');
  }
  verifySourceFn({ controllerRepositoryPath, baseSha: dispatch.baseCommit });
  return acceptClaudeWorkerQualificationResult({
    request: input.request,
    result: input.result,
    registry,
    now,
  });
}

function registryFromEnv(env) {
  return parseLiveWorkerRegistry(env, {
    expectedControllerNodeId: requiredEnv(env, CONTROLLER_NODE_ID_ENV),
  });
}

function boundedInput() {
  const text = readFileSync(0, 'utf8');
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
    throw new ClaudeWorkerQualificationCommandError('input-too-large');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ClaudeWorkerQualificationCommandError('invalid-json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClaudeWorkerQualificationCommandError('invalid-json');
  }
  return value;
}

function safeFailure(error) {
  const code = error instanceof ClaudeWorkerQualificationCommandError && /^[A-Za-z0-9._:-]{1,160}$/.test(error.code)
    ? error.code
    : (/^[A-Za-z0-9._:-]{1,160}$/.test(String(error?.message || '')) ? String(error.message) : 'claude-worker-qualification-command-failed');
  return Object.freeze({ schemaVersion: COMMAND_SCHEMA_VERSION, ok: false, errorCode: code });
}

async function main() {
  const mode = process.argv[2];
  if (!['build-request', 'execute', 'accept'].includes(mode) || process.argv.length !== 3) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: COMMAND_SCHEMA_VERSION, ok: false, errorCode: 'invalid-command-arguments' })}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const input = boundedInput();
    const registry = registryFromEnv(process.env);
    if (mode === 'build-request') {
      if (requiredEnv(process.env, CONTROLLER_NODE_ID_ENV) !== CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE) {
        throw new ClaudeWorkerQualificationCommandError('controller-node-mismatch');
      }
      const built = buildClaudeWorkerQualificationCommandRequest({
        input,
        registry,
        controllerRepositoryPath: requiredEnv(process.env, CONTROLLER_REPOSITORY_ENV),
      });
      process.stdout.write(`${JSON.stringify({ schemaVersion: COMMAND_SCHEMA_VERSION, ok: true, ...built })}\n`);
      return;
    }
    if (mode === 'execute') {
      const execution = await executeClaudeWorkerQualificationCommand({ input, registry, env: process.env });
      process.stdout.write(`${JSON.stringify({
        schemaVersion: COMMAND_SCHEMA_VERSION,
        ok: execution.result?.status === 'succeeded',
        replay: execution.replay === true,
        providerInvoked: execution.providerInvoked === true,
        result: execution.result,
      })}\n`);
      if (execution.result?.status !== 'succeeded') process.exitCode = 1;
      return;
    }
    if (requiredEnv(process.env, CONTROLLER_NODE_ID_ENV) !== CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE) {
      throw new ClaudeWorkerQualificationCommandError('controller-node-mismatch');
    }
    const acceptance = acceptClaudeWorkerQualificationCommandResult({
      input,
      registry,
      controllerRepositoryPath: requiredEnv(process.env, CONTROLLER_REPOSITORY_ENV),
      now: new Date(),
    });
    process.stdout.write(`${JSON.stringify({ schemaVersion: COMMAND_SCHEMA_VERSION, ok: acceptance.accepted, acceptance })}\n`);
    if (!acceptance.accepted) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
