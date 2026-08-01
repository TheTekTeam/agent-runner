import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  executeLocalExecutorJob,
} from './agent-runner-local-executor.mjs';
import { validateLocalExecutorPolicy } from './agent-runner-local-executor-policy.mjs';
import {
  evaluateValidationFreshness,
  LocalExecutorStore,
  runValidationProfile,
  validationProfileContractSha256,
} from './agent-runner-validation-profiles.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  );
}

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

function fixture({
  artifacts = [],
  workingDirectory = '.',
  requireCleanBefore = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'validation-security-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  git(
    repo,
    'remote',
    'add',
    'origin',
    'https://github.com/TheTekTeam/security-fixture.git',
  );
  const project = Object.freeze({
    projectId: 'security-fixture',
    githubRepo: 'TheTekTeam/security-fixture',
    localRepoPath: repo,
  });
  const registry = Object.freeze({
    projects: Object.freeze([project]),
    projectsById: Object.freeze({ 'security-fixture': project }),
  });
  const command = Object.freeze({
    argv: Object.freeze([
      process.execPath,
      '-e',
      artifacts.length > 0
        ? "require('node:fs').writeFileSync('proof.txt','proof')"
        : "process.stdout.write('ok')",
    ]),
    workingDirectory,
    environment: Object.freeze([]),
    timeoutSeconds: 30,
  });
  const policy = validateLocalExecutorPolicy({
    schemaVersion: 1,
    projects: [{
      projectId: project.projectId,
      defaultBranch: 'main',
      worktreeRoot: join(root, 'worktrees'),
      allowedOperations: ['validation.run'],
      validationProfiles: {
        thorough: {
          commands: [command],
          requireCleanBefore,
          requireCleanAfter: artifacts.length === 0,
          artifacts,
          evidenceTtlSeconds: 3600,
        },
      },
    }],
  });
  const store = new LocalExecutorStore(join(root, 'controller.sqlite'));
  return {
    root,
    repo,
    head: git(repo, 'rev-parse', 'HEAD'),
    project,
    registry,
    policy,
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function rawValidationInput({
  requestId,
  projectId,
  profileName,
  contractSha256,
  expectedSha,
  now,
}) {
  const identity = digest({
    requestId,
    projectId,
    profileName,
    profileContractSha256: contractSha256,
    expectedSha,
    target: 'canonical',
    worktreeName: null,
    riskClass: null,
  });
  return Object.freeze({
    schemaVersion: 1,
    jobId: `validation-job-${identity.slice(0, 48)}`,
    nonce: `validation-nonce-${identity}`,
    projectId,
    operation: 'validation.run',
    expectedSha,
    expiresAt: new Date(Date.parse(now) + 60 * 60_000).toISOString(),
    arguments: Object.freeze({
      profile: profileName,
      profileContractSha256: contractSha256,
      target: 'canonical',
    }),
  });
}

test('profile policy changes cannot replay evidence produced by older commands', () => {
  const value = fixture();
  try {
    const input = {
      requestId: 'policy-drift-request',
      projectId: value.project.projectId,
      profileName: 'thorough',
      expectedSha: value.head,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
      now: '2026-08-01T00:00:00.000Z',
    };
    const first = runValidationProfile(input);
    const changedPolicy = validateLocalExecutorPolicy({
      schemaVersion: 1,
      projects: [{
        projectId: value.project.projectId,
        defaultBranch: 'main',
        worktreeRoot: join(value.root, 'worktrees'),
        allowedOperations: ['validation.run'],
        validationProfiles: {
          thorough: {
            commands: [{
              argv: [process.execPath, '-e', "process.stdout.write('changed')"],
              timeoutSeconds: 30,
            }],
            evidenceTtlSeconds: 3600,
          },
        },
      }],
    });
    const second = runValidationProfile({
      ...input,
      policy: changedPolicy,
      now: '2026-08-01T00:01:00.000Z',
    });
    assert.equal(first.replay, false);
    assert.equal(second.replay, false);
    assert.notEqual(first.evidence.jobId, second.evidence.jobId);
    assert.notEqual(
      first.evidence.profileContractSha256,
      second.evidence.profileContractSha256,
    );
    assert.equal(
      value.store.db.prepare(
        'SELECT COUNT(*) AS count FROM validation_runs',
      ).get().count,
      2,
    );
    assert.deepEqual(
      evaluateValidationFreshness(first.evidence, {
        expectedSha: value.head,
        currentProfileContractSha256:
          second.evidence.profileContractSha256,
        now: '2026-08-01T00:02:00.000Z',
      }),
      {
        fresh: false,
        reason: 'validation-profile-contract-changed',
      },
    );
  } finally {
    value.close();
  }
});

test('a running validation job is preserved and never converted into evidence', () => {
  const value = fixture();
  try {
    const input = {
      requestId: 'running-job-request',
      projectId: value.project.projectId,
      profileName: 'thorough',
      expectedSha: value.head,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
      now: '2026-08-01T00:00:00.000Z',
    };
    const completed = runValidationProfile(input);
    value.store.db.prepare(
      'DELETE FROM validation_runs WHERE validation_id = ?',
    ).run(completed.evidence.validationId);
    value.store.db.prepare(`
      UPDATE local_executor_jobs
      SET state = 'running',
          finished_at = NULL,
          result_json = '{}',
          error_code = NULL
      WHERE job_id = ?
    `).run(completed.evidence.jobId);
    assert.throws(
      () => runValidationProfile(input),
      (error) => error?.code === 'validation-job-incomplete',
    );
    assert.equal(
      value.store.getJob(completed.evidence.jobId).state,
      'running',
    );
    assert.equal(
      value.store.db.prepare(
        'SELECT COUNT(*) AS count FROM validation_runs',
      ).get().count,
      0,
    );
  } finally {
    value.close();
  }
});

test('an interrupted evidence write is adopted only when target state is unchanged', () => {
  const value = fixture();
  try {
    const now = '2026-08-01T00:00:00.000Z';
    const contractSha256 = validationProfileContractSha256(
      value.policy,
      value.project.projectId,
      'thorough',
    );
    const input = rawValidationInput({
      requestId: 'raw-recovery-request',
      projectId: value.project.projectId,
      profileName: 'thorough',
      contractSha256,
      expectedSha: value.head,
      now,
    });
    const raw = executeLocalExecutorJob({
      input,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
      now,
    });
    assert.equal(raw.job.state, 'succeeded');
    assert.equal(
      value.store.db.prepare(
        'SELECT COUNT(*) AS count FROM validation_runs',
      ).get().count,
      0,
    );
    const recovered = runValidationProfile({
      requestId: 'raw-recovery-request',
      projectId: value.project.projectId,
      profileName: 'thorough',
      expectedSha: value.head,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
      now,
    });
    assert.equal(recovered.replay, true);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.evidence.state, 'succeeded');
    assert.deepEqual(
      Object.keys(value.store.getJob(input.jobId).result),
      ['validationEvidence'],
    );
  } finally {
    value.close();
  }
});

test('artifact evidence is never reconstructed after an interrupted write', () => {
  const value = fixture({ artifacts: ['proof.txt'] });
  try {
    const now = '2026-08-01T00:00:00.000Z';
    const contractSha256 = validationProfileContractSha256(
      value.policy,
      value.project.projectId,
      'thorough',
    );
    const input = rawValidationInput({
      requestId: 'artifact-recovery-request',
      projectId: value.project.projectId,
      profileName: 'thorough',
      contractSha256,
      expectedSha: value.head,
      now,
    });
    const raw = executeLocalExecutorJob({
      input,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
      now,
    });
    assert.equal(raw.job.state, 'succeeded');
    const recovered = runValidationProfile({
      requestId: 'artifact-recovery-request',
      projectId: value.project.projectId,
      profileName: 'thorough',
      expectedSha: value.head,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
      now,
    });
    assert.equal(recovered.evidence.state, 'failed');
    assert.equal(
      recovered.evidence.errorCode,
      'artifact-evidence-unavailable-after-recovery',
    );
    assert.deepEqual(recovered.evidence.artifacts, []);
  } finally {
    value.close();
  }
});

test('a symlinked working directory cannot escape the validation target', () => {
  const value = fixture({
    workingDirectory: 'escape',
    requireCleanBefore: false,
  });
  const outside = join(value.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(value.repo, 'escape'), 'dir');
  try {
    const result = runValidationProfile({
      requestId: 'symlink-cwd-request',
      projectId: value.project.projectId,
      profileName: 'thorough',
      expectedSha: value.head,
      registry: value.registry,
      policy: value.policy,
      store: value.store,
      uid: 1000,
      now: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(result.evidence.state, 'failed');
    assert.equal(result.evidence.errorCode, 'path-not-allowed');
    assert.equal(result.evidence.commands[0].status, null);
  } finally {
    value.close();
  }
});
