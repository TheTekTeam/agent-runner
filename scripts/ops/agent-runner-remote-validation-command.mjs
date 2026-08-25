#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { parseLiveWorkerRegistry } from './agent-runner-live-worker-routing.mjs';
import {
  AGENT_RUNNER_REMOTE_VALIDATION_PROFILES,
  RemoteValidationError,
  RemoteValidationReplayStore,
  acceptRemoteValidationResult,
  buildRemoteValidationRequest,
  executeRemoteValidationRequest,
} from './agent-runner-remote-validation.mjs';

const MAX_INPUT_BYTES = 64 * 1024;
const SOURCE_REPOSITORY_ENV = 'AGENT_RUNNER_REMOTE_VALIDATION_SOURCE_REPOSITORY';
const WORKTREE_ROOT_ENV = 'AGENT_RUNNER_REMOTE_VALIDATION_WORKTREE_ROOT';
const STATE_ROOT_ENV = 'AGENT_RUNNER_REMOTE_VALIDATION_STATE_ROOT';
const NODE_ID_ENV = 'AGENT_RUNNER_NODE_ID';
const CONTROLLER_NODE_ID_ENV = 'AGENT_RUNNER_CONTROLLER_NODE_ID';

function boundedInput() {
  const text = readFileSync(0, 'utf8');
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
    throw new RemoteValidationError('input-too-large', 'input exceeds bounded remote validation envelope');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RemoteValidationError('invalid-json', 'input must be JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteValidationError('invalid-json', 'input must be one JSON object');
  }
  return value;
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new RemoteValidationError('machine-config-missing', `${name} is not configured`);
  return value;
}

function registry() {
  return parseLiveWorkerRegistry(process.env, {
    expectedControllerNodeId: requiredEnv(CONTROLLER_NODE_ID_ENV),
  });
}

function exactFields(value, fields) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function buildRequest(input) {
  const fields = [
    'nodeId',
    'projectId',
    'repository',
    'sourceSha',
    'sourceTreeSha',
    'profileId',
    'authorityFingerprint',
    'authorityRevision',
    'requestedAt',
    'expiresAt',
  ];
  if (!exactFields(input, fields)) throw new RemoteValidationError('input-field-set-invalid', 'build-request field set is invalid');
  return buildRemoteValidationRequest({
    registry: registry(),
    profiles: AGENT_RUNNER_REMOTE_VALIDATION_PROFILES,
    ...input,
  });
}

function execute(input) {
  const reg = registry();
  const nodeId = requiredEnv(NODE_ID_ENV);
  const sourceRepositoryPath = requiredEnv(SOURCE_REPOSITORY_ENV);
  const worktreeRoot = requiredEnv(WORKTREE_ROOT_ENV);
  const stateRoot = requiredEnv(STATE_ROOT_ENV);
  const replayStore = new RemoteValidationReplayStore(stateRoot);
  return executeRemoteValidationRequest({
    request: input,
    registry: reg,
    executingNodeId: nodeId,
    sourceRepositoryPath,
    worktreeRoot,
    replayStore,
    profiles: AGENT_RUNNER_REMOTE_VALIDATION_PROFILES,
    env: process.env,
  });
}

function accept(input) {
  if (!exactFields(input, ['request', 'result'])) {
    throw new RemoteValidationError('input-field-set-invalid', 'accept field set is invalid');
  }
  return acceptRemoteValidationResult({
    request: input.request,
    result: input.result,
    registry: registry(),
    profiles: AGENT_RUNNER_REMOTE_VALIDATION_PROFILES,
    now: new Date(),
  });
}

function safeFailure(error) {
  const code = error instanceof RemoteValidationError && /^[a-z0-9._:-]{1,96}$/i.test(error.code)
    ? error.code
    : 'remote-validation-command-failed';
  return Object.freeze({ schemaVersion: 1, ok: false, errorCode: code });
}

function main() {
  const mode = process.argv[2];
  if (!['build-request', 'execute', 'accept'].includes(mode) || process.argv.length !== 3) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, errorCode: 'invalid-command-arguments' })}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const input = boundedInput();
    if (mode === 'build-request') {
      const request = buildRequest(input);
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, request })}\n`);
      return;
    }
    if (mode === 'execute') {
      const execution = execute(input);
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        ok: execution.result.status === 'succeeded',
        replay: execution.replay,
        result: execution.result,
      })}\n`);
      if (execution.result.status !== 'succeeded') process.exitCode = 1;
      return;
    }
    const acceptance = accept(input);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: acceptance.accepted, acceptance })}\n`);
    if (!acceptance.accepted) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  }
}

main();
