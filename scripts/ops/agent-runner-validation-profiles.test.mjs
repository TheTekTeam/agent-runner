import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { validateLocalExecutorPolicy } from './agent-runner-local-executor-policy.mjs';
import {
  comparePostMergeValidation,
  evaluateValidationFreshness,
  LocalExecutorStore,
  requiredProfilesForRisk,
  runValidationProfile,
} from './agent-runner-validation-profiles.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function createRepository(root, name, repository) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  git(path, 'config', 'user.email', 'fixture@example.invalid');
  git(path, 'config', 'user.name', 'Fixture');
  writeFileSync(join(path, 'README.md'), `${name}\n`);
  mkdirSync(join(path, 'sub'));
  writeFileSync(join(path, 'sub', '.keep'), '\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'fixture');
  git(path, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
  return Object.freeze({
    path,
    headSha: git(path, 'rev-parse', 'HEAD'),
  });
}

function projectConfig(projectId, repository, localRepoPath) {
  return Object.freeze({ projectId, githubRepo: repository, localRepoPath });
}

function projectPolicy(projectId, worktreeRoot, profiles, extra = {}) {
  return {
    projectId,
    defaultBranch: 'main',
    worktreeRoot,
    allowedOperations: ['project.inspect', 'validation.run'],
    validationProfiles: profiles,
    requiredValidationProfiles: { R1: [Object.keys(profiles)[0]] },
    maxOutputBytes: 1024 * 1024,
    ...extra,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'validation-profiles-'));
  const nodeRepo = createRepository(root, 'node-project', 'TheTekTeam/node-project');
  const pythonRepo = createRepository(root, 'python-project', 'TheTekTeam/python-project');
  const nodeProject = projectConfig('node-project', 'TheTekTeam/node-project', nodeRepo.path);
  const pythonProject = projectConfig('python-project', 'TheTekTeam/python-project', pythonRepo.path);
  const registry = Object.freeze({
    projects: Object.freeze([nodeProject, pythonProject]),
    projectsById: Object.freeze({
      'node-project': nodeProject,
      'python-project': pythonProject,
    }),
  });
  const policy = validateLocalExecutorPolicy({
    schemaVersion: 1,
    projects: [
      projectPolicy('node-project', join(root, 'node-worktrees'), {
        thorough: {
          commands: [{
            argv: [
              process.execPath,
              '-e',
              "const fs=require('node:fs');fs.writeFileSync('artifact.txt','node-proof')",
            ],
            workingDirectory: 'sub',
            timeoutSeconds: 30,
            environment: ['ALLOWED_VALUE'],
          }],
          requireCleanBefore: true,
          requireCleanAfter: false,
          artifacts: ['sub/artifact.txt'],
          evidenceTtlSeconds: 3600,
          riskClasses: ['R1'],
        },
        timeout: {
          commands: [{
            argv: [process.execPath, '-e', 'setTimeout(()=>{},5000)'],
            timeoutSeconds: 1,
          }],
          evidenceTtlSeconds: 3600,
        },
        environment: {
          commands: [{
            argv: [
              process.execPath,
              '-e',
              "if(process.env.ALLOWED_VALUE!=='yes'||process.env.SECRET_VALUE)process.exit(9)",
            ],
            environment: ['ALLOWED_VALUE'],
            timeoutSeconds: 30,
          }],
          evidenceTtlSeconds: 3600,
        },
      }),
      projectPolicy('python-project', join(root, 'python-worktrees'), {
        python: {
          commands: [{
            argv: [
              'python3',
              '-c',
              "from pathlib import Path; Path('python-proof.txt').write_text('python-proof')",
            ],
            timeoutSeconds: 30,
          }],
          requireCleanBefore: true,
          requireCleanAfter: false,
          artifacts: ['python-proof.txt'],
          evidenceTtlSeconds: 3600,
        },
      }),
    ],
  });
  const store = new LocalExecutorStore(join(root, 'controller.sqlite'));
  return {
    root,
    nodeRepo,
    pythonRepo,
    registry,
    policy,
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('policy accepts bounded working directories, artifacts, freshness and risk mappings', () => {
  const value = validateLocalExecutorPolicy({
    schemaVersion: 1,
    projects: [{
      projectId: 'fixture',
      defaultBranch: 'main',
      worktreeRoot: '/tmp/fixture-worktrees',
      allowedOperations: ['validation.run'],
      validationProfiles: {
        quick: {
          commands: [{
            argv: ['node', '--test'],
            workingDirectory: 'packages/api',
            environment: ['CI'],
          }],
          artifacts: ['reports/result.json'],
          evidenceTtlSeconds: 900,
          riskClasses: ['R1'],
        },
      },
      requiredValidationProfiles: { R1: ['quick'] },
    }],
  });
  assert.equal(value.projectsById.fixture.validationProfiles.quick.commands[0].workingDirectory, 'packages/api');
  assert.deepEqual(value.projectsById.fixture.validationProfiles.quick.artifacts, ['reports/result.json']);
  assert.deepEqual(requiredProfilesForRisk(value, 'fixture', 'R1'), ['quick']);
  assert.throws(
    () => validateLocalExecutorPolicy({
      schemaVersion: 1,
      projects: [{
        projectId: 'fixture',
        defaultBranch: 'main',
        worktreeRoot: '/tmp/fixture-worktrees',
        allowedOperations: ['validation.run'],
        validationProfiles: {
          quick: { commands: [{ argv: ['node'], workingDirectory: '../escape' }] },
        },
      }],
    }),
    /escapes the validation target/,
  );
});

test('one controller validates Node and Python projects with durable redacted evidence', () => {
  const value = fixture();
  try {
    const nodeResult = runValidationProfile({
      requestId: 'node-validation-0001',
      projectId: 'node-project',
      profileName: 'thorough',
      expectedSha: value.nodeRepo.headSha,
      riskClass: 'R1',
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      env: { ...process.env, ALLOWED_VALUE: 'yes', SECRET_VALUE: 'must-not-pass' },
      uid: 1000,
    });
    assert.equal(nodeResult.evidence.state, 'succeeded');
    assert.equal(nodeResult.evidence.observedSha, value.nodeRepo.headSha);
    assert.equal(nodeResult.evidence.commands[0].status, 0);
    assert.ok(Number.isInteger(nodeResult.evidence.commands[0].durationMs));
    assert.equal(nodeResult.evidence.artifacts[0].relativePath, 'sub/artifact.txt');
    assert.equal(JSON.stringify(nodeResult.evidence).includes(value.root), false);
    assert.equal(JSON.stringify(nodeResult.evidence).includes('must-not-pass'), false);

    const pythonResult = runValidationProfile({
      requestId: 'python-validation-0001',
      projectId: 'python-project',
      profileName: 'python',
      expectedSha: value.pythonRepo.headSha,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
    });
    assert.equal(pythonResult.evidence.state, 'succeeded');
    assert.equal(pythonResult.evidence.artifacts[0].relativePath, 'python-proof.txt');

    const rawJob = value.store.getJob(nodeResult.evidence.jobId);
    assert.deepEqual(Object.keys(rawJob.result), ['validationEvidence']);
    assert.equal(JSON.stringify(rawJob.result).includes(value.root), false);
  } finally {
    value.close();
  }
});

test('exact SHA mismatch fails before the first declared command', () => {
  const value = fixture();
  try {
    const result = runValidationProfile({
      requestId: 'node-validation-sha-mismatch',
      projectId: 'node-project',
      profileName: 'thorough',
      expectedSha: '0'.repeat(40),
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
    });
    assert.equal(result.evidence.state, 'failed');
    assert.equal(result.evidence.errorCode, 'expected-sha-mismatch');
    assert.equal(result.evidence.expectedSha, '0'.repeat(40));
    assert.equal(result.evidence.observedSha, value.nodeRepo.headSha);
    assert.equal(result.evidence.commands[0].status, null);
  } finally {
    value.close();
  }
});

test('timeout is durable failure evidence with a measured bounded command', () => {
  const value = fixture();
  try {
    const result = runValidationProfile({
      requestId: 'node-validation-timeout',
      projectId: 'node-project',
      profileName: 'timeout',
      expectedSha: value.nodeRepo.headSha,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
    });
    assert.equal(result.evidence.state, 'failed');
    assert.equal(result.evidence.errorCode, 'command-timeout');
    assert.ok(result.evidence.commands[0].durationMs >= 900);
    assert.equal(value.store.getJob(result.evidence.jobId).state, 'failed');
  } finally {
    value.close();
  }
});

test('only positively allowlisted environment names reach validation commands', () => {
  const value = fixture();
  try {
    const result = runValidationProfile({
      requestId: 'node-validation-environment',
      projectId: 'node-project',
      profileName: 'environment',
      expectedSha: value.nodeRepo.headSha,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      env: { ...process.env, ALLOWED_VALUE: 'yes', SECRET_VALUE: 'hidden' },
      uid: 1000,
    });
    assert.equal(result.evidence.state, 'succeeded');
    assert.deepEqual(result.evidence.commands[0].environmentNames, ['ALLOWED_VALUE']);
  } finally {
    value.close();
  }
});

test('artifact bounds convert an otherwise successful command into failed evidence', () => {
  const value = fixture();
  try {
    const policy = validateLocalExecutorPolicy({
      schemaVersion: 1,
      projects: [
        projectPolicy('node-project', join(value.root, 'bounded-worktrees'), {
          bounded: {
            commands: [{
              argv: [
                process.execPath,
                '-e',
                "require('node:fs').writeFileSync('large.bin',Buffer.alloc(128))",
              ],
            }],
            requireCleanAfter: false,
            artifacts: ['large.bin'],
          },
        }, { maxValidationArtifactBytes: 64 }),
      ],
    });
    const result = runValidationProfile({
      requestId: 'node-validation-artifact-bound',
      projectId: 'node-project',
      profileName: 'bounded',
      expectedSha: value.nodeRepo.headSha,
      registry: value.registry,
      policy,
      store: value.store,
      uid: 1000,
    });
    assert.equal(result.evidence.state, 'failed');
    assert.equal(result.evidence.errorCode, 'artifact-bytes-exceeded');
    assert.equal(value.store.getJob(result.evidence.jobId).state, 'failed');
  } finally {
    value.close();
  }
});

test('replay is idempotent and fails closed when referenced durable evidence is missing', () => {
  const value = fixture();
  try {
    const input = {
      requestId: 'node-validation-replay',
      projectId: 'node-project',
      profileName: 'thorough',
      expectedSha: value.nodeRepo.headSha,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
    };
    const first = runValidationProfile(input);
    const replay = runValidationProfile(input);
    assert.equal(replay.replay, true);
    assert.equal(replay.evidence.validationId, first.evidence.validationId);

    value.store.db.prepare('DELETE FROM validation_runs WHERE validation_id = ?')
      .run(first.evidence.validationId);

    assert.throws(
      () => runValidationProfile(input),
      (error) => (
        error?.code === 'validation-evidence-store-inconsistent'
        && error?.message
          === 'validation job references missing durable evidence'
      ),
    );
  } finally {
    value.close();
  }
});

test('freshness and post-merge comparison fail closed on stale or changed contracts', () => {
  const command = {
    ordinal: 0,
    executable: 'node',
    argvSha256: 'a'.repeat(64),
    workingDirectory: '.',
    environmentNames: [],
    timeoutSeconds: 30,
    status: 0,
    signal: null,
    durationMs: 1,
    stdout: { bytes: 0, sha256: 'b'.repeat(64) },
    stderr: { bytes: 0, sha256: 'b'.repeat(64) },
  };
  const pre = {
    state: 'succeeded',
    projectId: 'fixture',
    profile: 'quick',
    expectedSha: '1'.repeat(40),
    observedSha: '1'.repeat(40),
    finishedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-01T02:00:00.000Z',
    commands: [command],
    artifacts: [{ relativePath: 'report.json', bytes: 1, sha256: 'c'.repeat(64) }],
  };
  assert.deepEqual(
    evaluateValidationFreshness(pre, { expectedSha: pre.expectedSha, now: '2026-08-01T01:00:00.000Z' }),
    { fresh: true, reason: 'validation-fresh' },
  );
  assert.equal(
    evaluateValidationFreshness(pre, { expectedSha: pre.expectedSha, now: '2026-08-01T03:00:00.000Z' }).reason,
    'validation-expired',
  );
  const post = {
    ...pre,
    expectedSha: '2'.repeat(40),
    observedSha: '2'.repeat(40),
    finishedAt: '2026-08-01T01:30:00.000Z',
    artifacts: [{ relativePath: 'report.json', bytes: 1, sha256: 'd'.repeat(64) }],
  };
  const comparison = comparePostMergeValidation(pre, post);
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.artifactDigestsEqual, false);
  const drifted = comparePostMergeValidation(pre, {
    ...post,
    commands: [{ ...command, argvSha256: 'e'.repeat(64) }],
  });
  assert.equal(drifted.comparable, false);
  assert.equal(drifted.reason, 'command-contract-changed');
});

test('root execution is refused before an executor job is created', () => {
  const value = fixture();
  try {
    assert.throws(
      () => runValidationProfile({
        requestId: 'node-validation-root',
        projectId: 'node-project',
        profileName: 'thorough',
        expectedSha: value.nodeRepo.headSha,
        registry: value.registry,
        policy: value.policy,
        store: value.store,
        uid: 0,
      }),
      /must not run as root/,
    );
    assert.equal(value.store.db.prepare('SELECT COUNT(*) AS count FROM local_executor_jobs').get().count, 0);
  } finally {
    value.close();
  }
});
