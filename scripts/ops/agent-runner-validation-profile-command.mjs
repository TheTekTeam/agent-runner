#!/usr/bin/env node
import process from 'node:process';

import { loadProjectRegistry } from './agent-runner-project-registry.mjs';
import { loadLocalExecutorPolicy } from './agent-runner-local-executor-policy.mjs';
import {
  LocalExecutorStore,
  runValidationProfile,
} from './agent-runner-validation-profiles.mjs';

function parse(argv) {
  const value = {
    target: 'canonical',
    riskClass: null,
    worktreeName: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error('unexpected positional argument');
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value`);
    index += 1;
    if (name === 'project-registry') value.registryPath = next;
    else if (name === 'executor-policy') value.policyPath = next;
    else if (name === 'db') value.dbPath = next;
    else if (name === 'project') value.projectId = next;
    else if (name === 'profile') value.profileName = next;
    else if (name === 'expected-sha') value.expectedSha = next;
    else if (name === 'request-id') value.requestId = next;
    else if (name === 'target') value.target = next;
    else if (name === 'worktree-name') value.worktreeName = next;
    else if (name === 'risk-class') value.riskClass = next;
    else throw new Error(`unknown argument --${name}`);
  }
  for (const required of [
    'registryPath',
    'policyPath',
    'dbPath',
    'projectId',
    'profileName',
    'expectedSha',
    'requestId',
  ]) {
    if (!value[required]) throw new Error(`missing required ${required}`);
  }
  if (!['canonical', 'worktree'].includes(value.target)) throw new Error('target must be canonical or worktree');
  if (value.target === 'worktree' && !value.worktreeName) throw new Error('worktree target requires --worktree-name');
  return Object.freeze(value);
}

function safeFailure(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9._:-]{1,64}$/i.test(error.code)
    ? error.code
    : 'validation-command-failed';
  return Object.freeze({
    schemaVersion: 1,
    ok: false,
    errorCode: code,
  });
}

function main() {
  let args;
  try {
    args = parse(process.argv.slice(2));
  } catch {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      errorCode: 'invalid-command-arguments',
    })}\n`);
    process.exitCode = 2;
    return;
  }

  const store = new LocalExecutorStore(args.dbPath);
  try {
    const registry = loadProjectRegistry({ registryPath: args.registryPath });
    const policy = loadLocalExecutorPolicy({ policyPath: args.policyPath });
    const result = runValidationProfile({
      ...args,
      registry,
      policy,
      store,
    });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: result.evidence.state === 'succeeded',
      replay: result.replay,
      validationId: result.evidence.validationId,
      projectId: result.evidence.projectId,
      repository: result.evidence.repository,
      profile: result.evidence.profile,
      target: result.evidence.target,
      expectedSha: result.evidence.expectedSha,
      observedSha: result.evidence.observedSha,
      state: result.evidence.state,
      expiresAt: result.evidence.expiresAt,
      commandCount: result.evidence.commands.length,
      artifactCount: result.evidence.artifacts.length,
      errorCode: result.evidence.errorCode,
    })}\n`);
    if (result.evidence.state !== 'succeeded') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
