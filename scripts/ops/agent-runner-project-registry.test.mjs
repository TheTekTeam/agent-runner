import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadProjectRegistry,
  projectFromRegistryById,
  projectFromRegistryByRepository,
  resolveProjectRegistryPath,
  stripProjectRegistryArgs,
  validateProjectRegistryManifest,
} from './agent-runner-project-registry.mjs';

function projectConfig(projectId, githubRepo, localRepoPath, overrides = {}) {
  return {
    projectId,
    displayName: projectId,
    githubRepo,
    localRepoPath,
    outputDir: '.var/agent-runner',
    stateDbPath: `.var/agent-runner/${projectId}.sqlite`,
    acceptedAgentLabels: ['agent:claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0', 'priority:P1'],
    safeDefaultValidationCommands: ['npm test'],
    systemd: { serviceName: `${projectId}.service`, timerName: `${projectId}.timer` },
    runner: { lockPath: `.var/agent-runner/${projectId}.lock`, candidateLimit: 20 },
    ...overrides,
  };
}

function withRegistry(files, registry, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-project-registry-'));
  try {
    for (const [name, payload] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(payload, null, 2));
    }
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2));
    return fn(registryPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loads multiple projects and provides deterministic id/repository lookup', () => withRegistry({
  'alpha.json': projectConfig('alpha', 'Owner/Alpha', '/srv/alpha'),
  'beta.json': projectConfig('beta', 'Owner/Beta', '/srv/beta'),
}, {
  schemaVersion: 1,
  defaultProjectId: 'beta',
  projects: ['alpha.json', { configPath: 'beta.json', enabled: true }],
}, (registryPath) => {
  const registry = loadProjectRegistry({ registryPath });
  assert.equal(registry.defaultProjectId, 'beta');
  assert.deepEqual(registry.projects.map((project) => project.projectId), ['alpha', 'beta']);
  assert.equal(projectFromRegistryById(registry, 'alpha').githubRepo, 'Owner/Alpha');
  assert.equal(projectFromRegistryByRepository(registry, 'owner/BETA').projectId, 'beta');
}));

test('resolves and strips project-registry CLI/env arguments', () => {
  assert.equal(resolveProjectRegistryPath(['--project-registry', '/tmp/registry.json'], {}), '/tmp/registry.json');
  assert.equal(
    resolveProjectRegistryPath([], { AGENT_RUNNER_PROJECT_REGISTRY: '/tmp/env.json' }),
    '/tmp/env.json',
  );
  assert.deepEqual(
    stripProjectRegistryArgs(['--project-registry=/tmp/x.json', '--limit', '4']),
    ['--limit', '4'],
  );
  assert.throws(() => resolveProjectRegistryPath(['--project-registry', '--limit'], {}), /requires a value/);
});

test('rejects duplicate project ids, repositories, paths, state DBs and locks', () => {
  const cases = [
    {
      name: 'projectId',
      one: projectConfig('same', 'Owner/One', '/srv/one'),
      two: projectConfig('same', 'Owner/Two', '/srv/two'),
      pattern: /duplicate projectId 'same'/,
    },
    {
      name: 'githubRepo',
      one: projectConfig('one', 'Owner/Shared', '/srv/one'),
      two: projectConfig('two', 'owner/shared', '/srv/two'),
      pattern: /duplicate githubRepo 'owner\/shared'/,
    },
    {
      name: 'localRepoPath',
      one: projectConfig('one', 'Owner/One', '/srv/shared'),
      two: projectConfig('two', 'Owner/Two', '/srv/other/../shared'),
      pattern: /duplicate localRepoPath '\/srv\/shared'/,
    },
    {
      name: 'stateDbPath',
      one: projectConfig('one', 'Owner/One', '/srv/one', { stateDbPath: '/var/lib/agent-runner/shared.sqlite' }),
      two: projectConfig('two', 'Owner/Two', '/srv/two', { stateDbPath: '/var/lib/agent-runner/shared.sqlite' }),
      pattern: /duplicate stateDbPath '\/var\/lib\/agent-runner\/shared.sqlite'/,
    },
    {
      name: 'lockPath',
      one: projectConfig('one', 'Owner/One', '/srv/one', {
        runner: { lockPath: '/run/user/1000/agent-runner/shared.lock', candidateLimit: 20 },
      }),
      two: projectConfig('two', 'Owner/Two', '/srv/two', {
        runner: { lockPath: '/run/user/1000/agent-runner/shared.lock', candidateLimit: 20 },
      }),
      pattern: /duplicate lockPath '\/run\/user\/1000\/agent-runner\/shared.lock'/,
    },
  ];

  for (const duplicateCase of cases) {
    withRegistry({
      'one.json': duplicateCase.one,
      'two.json': duplicateCase.two,
    }, { schemaVersion: 1, projects: ['one.json', 'two.json'] }, (registryPath) => {
      assert.throws(
        () => loadProjectRegistry({ registryPath }),
        duplicateCase.pattern,
        duplicateCase.name,
      );
    });
  }
});

test('rejects malformed registry JSON without exposing file contents', () => withRegistry(
  {},
  '{not-json',
  (registryPath) => {
    assert.throws(() => loadProjectRegistry({ registryPath }), /Invalid agent runner project registry JSON/);
  },
));

test('rejects a missing project config', () => withRegistry(
  {},
  { schemaVersion: 1, projects: ['missing.json'] },
  (registryPath) => {
    assert.throws(() => loadProjectRegistry({ registryPath }), /Unable to read agent runner config/);
  },
));

test('validates registry schema and requires an enabled default project', () => {
  assert.throws(
    () => validateProjectRegistryManifest({ schemaVersion: 2, projects: [] }),
    /schemaVersion must equal 1.*projects must contain/,
  );
  withRegistry({
    'alpha.json': projectConfig('alpha', 'Owner/Alpha', '/srv/alpha'),
    'beta.json': projectConfig('beta', 'Owner/Beta', '/srv/beta'),
  }, {
    schemaVersion: 1,
    defaultProjectId: 'beta',
    projects: ['alpha.json', { configPath: 'beta.json', enabled: false }],
  }, (registryPath) => {
    assert.throws(
      () => loadProjectRegistry({ registryPath }),
      /defaultProjectId 'beta' is not an enabled project/,
    );
  });
});
