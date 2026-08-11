import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadProjectRegistry } from './agent-runner-project-registry.mjs';
import {
  ProjectRegistryManagementError,
  addProject,
  buildManagedProjectConfig,
  inspectLocalCheckout,
  listProjects,
  parseGitRemoteRepository,
  removeProject,
  setDefaultProject,
  setProjectEnabled,
  showProject,
  sweepStaleRegistryTempFiles,
  validateRegistry,
} from './agent-runner-project-registry-store.mjs';

// ---------------------------------------------------------------------------
// Fixtures: two *materially different* projects.
//
//   modelspend   - an operator-authored config with repository-relative
//                  output/state/lock paths, its own label vocabulary and its
//                  own systemd names. Seeded directly into the registry, as a
//                  pre-existing #100 installation would be.
//   agent-runner - added through the management contract itself, so its
//                  config is generated with absolute per-project XDG state
//                  paths and runner-generic labels.
// ---------------------------------------------------------------------------

function seedConfig(projectId, githubRepo, localRepoPath, overrides = {}) {
  return {
    projectId,
    displayName: `${projectId} fixture`,
    githubRepo,
    localRepoPath,
    outputDir: '.var/agent-runner',
    stateDbPath: '.var/agent-runner/runner-state.sqlite',
    acceptedAgentLabels: ['agent:claude', 'agent:codex-claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0', 'priority:P1', 'priority:P2'],
    safeDefaultValidationCommands: ['npm test'],
    systemd: { serviceName: `${projectId}-runner.service`, timerName: `${projectId}-runner.timer` },
    runner: { lockPath: '.var/agent-runner/cron.lock', candidateLimit: 100 },
    ...overrides,
  };
}

/**
 * A sandbox HOME with a valid single-project registry, a real git-shaped
 * checkout per project and a git spy that records every inspection command.
 */
function withSandbox(fn, { seedOverrides = {}, defaultProjectId = 'modelspend', seedEnabled = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-runner-registry-store-'));
  try {
    const env = { HOME: home };
    const registryDir = join(home, '.config', 'agent-runner');
    const registryPath = join(registryDir, 'projects.json');
    mkdirSync(join(registryDir, 'projects'), { recursive: true });

    const modelspendCheckout = join(home, 'workspace', 'modelspend');
    const agentRunnerCheckout = join(home, 'workspace', 'agent-runner');
    for (const checkout of [modelspendCheckout, agentRunnerCheckout]) {
      mkdirSync(join(checkout, '.git'), { recursive: true });
    }
    // Pre-existing project state that must survive disable/remove.
    mkdirSync(join(modelspendCheckout, '.var', 'agent-runner'), { recursive: true });
    const seedStateDb = join(modelspendCheckout, '.var', 'agent-runner', 'runner-state.sqlite');
    writeFileSync(seedStateDb, 'fixture-state');

    const seedConfigPath = join(registryDir, 'projects', 'modelspend.json');
    const seeded = seedConfig('modelspend', 'TheTekTeam/modelspend', modelspendCheckout, seedOverrides);
    writeFileSync(
      seedConfigPath,
      `${JSON.stringify(seeded, null, 2).split('{HOME}').join(home)}\n`,
    );
    const manifest = { schemaVersion: 1, projects: [{ configPath: 'projects/modelspend.json', enabled: seedEnabled }] };
    if (defaultProjectId) manifest.defaultProjectId = defaultProjectId;
    writeFileSync(registryPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const gitCalls = [];
    const runGit = (args) => {
      gitCalls.push(args);
      if (args.includes('--is-inside-work-tree')) return 'true';
      if (args.includes('remote.origin.url')) {
        return args[1].endsWith('agent-runner')
          ? 'git@github.com:TheTekTeam/agent-runner.git'
          : 'https://github.com/TheTekTeam/modelspend.git';
      }
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    };

    return fn({
      home,
      env,
      registryDir,
      registryPath,
      seedConfigPath,
      seedStateDb,
      modelspendCheckout,
      agentRunnerCheckout,
      gitCalls,
      deps: { runGit },
      auditPath: join(home, '.local', 'state', 'agent-runner', 'project-registry-audit.jsonl'),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function readAudit(auditPath) {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function addAgentRunner(sandbox, overrides = {}) {
  return addProject({
    env: sandbox.env,
    projectId: 'agent-runner',
    githubRepo: 'TheTekTeam/agent-runner',
    localRepoPath: sandbox.agentRunnerCheckout,
    displayName: 'Agent Runner',
    deps: sandbox.deps,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

test('adds a first additional project disabled by default and leaves the prior project untouched', () => withSandbox((sandbox) => {
  const before = readFileSync(sandbox.seedConfigPath, 'utf8');
  const result = addAgentRunner(sandbox);

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.projectId, 'agent-runner');
  assert.equal(result.details.enabled, false);
  assert.notEqual(result.beforeDigest, result.afterDigest);

  const view = listProjects({ env: sandbox.env });
  assert.deepEqual(view.projects.map((project) => [project.projectId, project.enabled]), [
    ['modelspend', true],
    ['agent-runner', false],
  ]);
  assert.equal(view.registryValid, true);
  assert.equal(view.defaultProjectId, 'modelspend');

  // The pre-existing project's identity, config bytes and state are untouched.
  assert.equal(readFileSync(sandbox.seedConfigPath, 'utf8'), before);
  assert.equal(readFileSync(sandbox.seedStateDb, 'utf8'), 'fixture-state');

  // The generated config is a canonical, per-project-isolated config.
  const generated = JSON.parse(readFileSync(join(sandbox.registryDir, 'projects', 'agent-runner.json'), 'utf8'));
  assert.equal(generated.githubRepo, 'TheTekTeam/agent-runner');
  assert.equal(generated.stateDbPath, join(sandbox.home, '.local/state/agent-runner/agent-runner/runner-state.sqlite'));
  assert.equal(generated.runner.lockPath, join(sandbox.home, '.local/state/agent-runner/agent-runner/cron.lock'));
  assert.deepEqual(generated.safeDefaultValidationCommands, []);

  // The registry still loads through the canonical #100 loader, and only the
  // enabled project is admitted.
  const registry = loadProjectRegistry({ registryPath: sandbox.registryPath });
  assert.deepEqual(registry.projects.map((project) => project.projectId), ['modelspend']);
}));

test('add only enables a project when the operator explicitly asks for it', () => withSandbox((sandbox) => {
  const result = addAgentRunner(sandbox, { enable: true });
  assert.equal(result.details.enabled, true);

  const registry = loadProjectRegistry({ registryPath: sandbox.registryPath });
  assert.deepEqual(registry.projects.map((project) => project.projectId).sort(), ['agent-runner', 'modelspend']);
  assert.equal(registry.defaultProjectId, 'modelspend');
}));

test('explicit enable admits a disabled project and disable withdraws it without deleting anything', () => withSandbox((sandbox) => {
  addAgentRunner(sandbox);
  const generatedConfigPath = join(sandbox.registryDir, 'projects', 'agent-runner.json');
  const generatedBefore = readFileSync(generatedConfigPath, 'utf8');

  // Simulate accumulated project state and evidence that disable must keep.
  const stateRoot = join(sandbox.home, '.local', 'state', 'agent-runner', 'agent-runner');
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, 'runner-state.sqlite'), 'agent-runner-state');

  const enabled = setProjectEnabled({ env: sandbox.env, projectId: 'agent-runner', enabled: true });
  assert.equal(enabled.changed, true);
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 2);

  const repeat = setProjectEnabled({ env: sandbox.env, projectId: 'agent-runner', enabled: true });
  assert.equal(repeat.changed, false, 'enabling an enabled project is a no-op');
  assert.equal(repeat.beforeDigest, repeat.afterDigest);

  const disabled = setProjectEnabled({ env: sandbox.env, projectId: 'agent-runner', enabled: false });
  assert.equal(disabled.changed, true);

  // Admission changed; config, state and checkout did not.
  assert.deepEqual(
    loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.map((project) => project.projectId),
    ['modelspend'],
  );
  assert.equal(readFileSync(generatedConfigPath, 'utf8'), generatedBefore);
  assert.equal(readFileSync(join(stateRoot, 'runner-state.sqlite'), 'utf8'), 'agent-runner-state');
  assert.equal(existsSync(join(sandbox.agentRunnerCheckout, '.git')), true);

  // A disabled project stays visible to the management contract with a
  // bounded reason instead of disappearing.
  const shown = showProject({ env: sandbox.env, projectId: 'agent-runner' });
  assert.equal(shown.project.enabled, false);
  assert.equal(shown.project.registryAdmitted, false);
  assert.equal(shown.project.admissionReason, 'disabled');
  assert.equal(shown.project.schedulerEligible, null);
}));

test('every enabled-state change is visible to the very next full registry load', () => withSandbox((sandbox) => {
  addAgentRunner(sandbox);
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 1);
  setProjectEnabled({ env: sandbox.env, projectId: 'agent-runner', enabled: true });
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 2);
  setProjectEnabled({ env: sandbox.env, projectId: 'agent-runner', enabled: false });
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 1);
}));

test('remove is non-destructive: config is archived, checkout and state are preserved', () => withSandbox((sandbox) => {
  addAgentRunner(sandbox, { enable: true });
  const generatedConfigPath = join(sandbox.registryDir, 'projects', 'agent-runner.json');
  const generatedBefore = readFileSync(generatedConfigPath, 'utf8');
  const stateRoot = join(sandbox.home, '.local', 'state', 'agent-runner', 'agent-runner');
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(join(stateRoot, 'runner-state.sqlite'), 'agent-runner-state');

  const result = removeProject({ env: sandbox.env, projectId: 'agent-runner' });
  assert.equal(result.changed, true);
  assert.equal(result.details.archivedConfig, true);
  assert.equal(result.details.statePreserved, true);

  assert.equal(existsSync(generatedConfigPath), false, 'config no longer occupies the active registry slot');
  const archived = join(sandbox.registryDir, 'archived-projects', 'agent-runner.json');
  assert.equal(readFileSync(archived, 'utf8'), generatedBefore, 'archived config is byte-identical');
  assert.equal(readFileSync(join(stateRoot, 'runner-state.sqlite'), 'utf8'), 'agent-runner-state');
  assert.equal(existsSync(join(sandbox.agentRunnerCheckout, '.git')), true);

  const registry = loadProjectRegistry({ registryPath: sandbox.registryPath });
  assert.deepEqual(registry.projects.map((project) => project.projectId), ['modelspend']);

  // A second add of the same project must not silently overwrite the archive.
  addAgentRunner(sandbox);
  removeProject({ env: sandbox.env, projectId: 'agent-runner' });
  assert.equal(existsSync(join(sandbox.registryDir, 'archived-projects', 'agent-runner.1.json')), true);
}));

test('default-project safety: the default cannot be removed or left unenabled', () => withSandbox((sandbox) => {
  addAgentRunner(sandbox, { enable: true });

  assert.throws(
    () => removeProject({ env: sandbox.env, projectId: 'modelspend' }),
    (error) => error instanceof ProjectRegistryManagementError && error.code === 'default-project-required',
  );
  assert.throws(
    () => setProjectEnabled({ env: sandbox.env, projectId: 'modelspend', enabled: false }),
    (error) => error.code === 'default-project-not-enabled',
  );
  // Registry is untouched by both refusals.
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 2);

  setDefaultProject({ env: sandbox.env, projectId: 'agent-runner' });
  setProjectEnabled({ env: sandbox.env, projectId: 'modelspend', enabled: false });
  const registry = loadProjectRegistry({ registryPath: sandbox.registryPath });
  assert.equal(registry.defaultProjectId, 'agent-runner');
  assert.deepEqual(registry.projects.map((project) => project.projectId), ['agent-runner']);

  // Disabling the last enabled project is refused, not silently accepted.
  assert.throws(
    () => setProjectEnabled({ env: sandbox.env, projectId: 'agent-runner', enabled: false }),
    (error) => error.code === 'no-enabled-project',
  );
  // The only registered project cannot be removed either.
  removeProject({ env: sandbox.env, projectId: 'modelspend' });
  assert.throws(
    () => removeProject({ env: sandbox.env, projectId: 'agent-runner' }),
    (error) => error.code === 'registry-would-be-empty',
  );
}));

test('refuses duplicate project id, repository, checkout path, state DB and lock path', () => {
  // Duplicate project id and repository (case-insensitive) against the seed.
  withSandbox((sandbox) => {
    assert.throws(
      () => addProject({
        env: sandbox.env,
        projectId: 'modelspend',
        githubRepo: 'TheTekTeam/agent-runner',
        localRepoPath: sandbox.agentRunnerCheckout,
        deps: sandbox.deps,
      }),
      (error) => error.code === 'project-exists',
    );
    assert.throws(
      () => addProject({
        env: sandbox.env,
        projectId: 'modelspend-mirror',
        githubRepo: 'thetekteam/MODELSPEND',
        localRepoPath: sandbox.agentRunnerCheckout,
        deps: { runGit: () => 'true' },
        allowMissingCheckout: true,
      }),
      (error) => error.code === 'duplicate-githubRepo',
    );
    assert.throws(
      () => addProject({
        env: sandbox.env,
        projectId: 'modelspend-clone',
        githubRepo: 'TheTekTeam/other',
        localRepoPath: sandbox.modelspendCheckout,
        deps: { runGit: () => 'true' },
      }),
      (error) => error.code === 'duplicate-localRepoPath',
    );
    // Nothing partial was written by any refusal.
    assert.equal(existsSync(join(sandbox.registryDir, 'projects', 'modelspend-mirror.json')), false);
    assert.equal(existsSync(join(sandbox.registryDir, 'projects', 'modelspend-clone.json')), false);
    assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 1);
  });

  // A seed config that already owns the state DB path the new project would
  // generate must block the addition.
  withSandbox((sandbox) => {
    assert.throws(
      () => addAgentRunner(sandbox),
      (error) => error.code === 'duplicate-stateDbPath',
    );
  }, {
    seedOverrides: { stateDbPath: '{HOME}/.local/state/agent-runner/agent-runner/runner-state.sqlite' },
  });

  // Same for the runner execution lock.
  withSandbox((sandbox) => {
    assert.throws(
      () => addAgentRunner(sandbox),
      (error) => error.code === 'duplicate-lockPath',
    );
  }, {
    seedOverrides: { runner: { lockPath: '{HOME}/.local/state/agent-runner/agent-runner/cron.lock', candidateLimit: 100 } },
  });
});

test('refuses malformed and missing required project fields without writing anything', () => withSandbox((sandbox) => {
  assert.throws(
    () => addProject({ env: sandbox.env, deps: sandbox.deps }),
    (error) => error.code === 'missing-required-fields'
      && error.details.missing.join(',') === 'projectId,githubRepo,localRepoPath',
  );
  assert.throws(
    () => addProject({
      env: sandbox.env,
      projectId: 'Bad Id',
      githubRepo: 'not-a-repo',
      localRepoPath: 'relative/path',
      deps: sandbox.deps,
    }),
    (error) => error.code === 'invalid-field-format'
      && error.details.invalid.join(',') === 'projectId,githubRepo,localRepoPath',
  );
  assert.throws(
    () => addProject({
      env: sandbox.env,
      projectId: 'agent-runner',
      githubRepo: 'TheTekTeam/agent-runner',
      localRepoPath: join(sandbox.home, 'workspace', 'not-cloned'),
      deps: sandbox.deps,
    }),
    (error) => error.code === 'checkout-not-ready',
  );
  assert.throws(
    () => addProject({
      env: sandbox.env,
      projectId: 'agent-runner',
      githubRepo: 'TheTekTeam/agent-runner',
      localRepoPath: sandbox.modelspendCheckout,
      deps: sandbox.deps,
    }),
    (error) => error.code === 'checkout-repository-mismatch',
  );
  assert.throws(
    () => setProjectEnabled({ env: sandbox.env, projectId: 'missing', enabled: true }),
    (error) => error.code === 'project-not-found',
  );

  assert.equal(readFileSync(sandbox.registryPath, 'utf8').includes('agent-runner'), false);
  assert.equal(existsSync(join(sandbox.registryDir, 'projects', 'agent-runner.json')), false);
}));

test('a registry whose project config is malformed refuses mutation and reports a bounded reason', () => withSandbox((sandbox) => {
  writeFileSync(sandbox.seedConfigPath, '{not json');

  const view = listProjects({ env: sandbox.env });
  assert.equal(view.registryValid, false);
  assert.equal(view.registryReason, 'config-malformed-json');
  assert.equal(view.projects[0].configValid, false);
  assert.equal(view.projects[0].registryAdmitted, false);

  assert.equal(validateRegistry({ env: sandbox.env }).ok, false);
  assert.throws(
    () => addAgentRunner(sandbox),
    (error) => error.code === 'config-malformed-json',
  );

  // Canonical #100 config validation is the contract: a structurally valid
  // JSON file that is not a valid project config is rejected the same way.
  writeFileSync(sandbox.seedConfigPath, JSON.stringify({ projectId: 'modelspend' }));
  assert.equal(listProjects({ env: sandbox.env }).registryReason, 'config-invalid-fields');
  assert.throws(() => addAgentRunner(sandbox), (error) => error.code === 'config-invalid-fields');
}));

test('a held registry mutation lock blocks concurrent mutation and preserves state', () => withSandbox((sandbox) => {
  const lockPath = join(sandbox.registryDir, '.projects.registry.lock');
  // A live-process lock, exactly as another in-flight mutation would leave it.
  writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
  const before = readFileSync(sandbox.registryPath, 'utf8');

  assert.throws(
    () => addAgentRunner(sandbox),
    (error) => error instanceof ProjectRegistryManagementError && error.code === 'registry-locked',
  );
  assert.equal(readFileSync(sandbox.registryPath, 'utf8'), before);
  assert.equal(existsSync(join(sandbox.registryDir, 'projects', 'agent-runner.json')), false);

  rmSync(lockPath);
  assert.equal(addAgentRunner(sandbox).changed, true, 'mutation succeeds once the lock is released');
  assert.equal(existsSync(lockPath), false, 'the mutation lock is released again');
}));

test('a failure between the config write and the registry write rolls back exactly', () => withSandbox((sandbox) => {
  const registryBefore = readFileSync(sandbox.registryPath, 'utf8');
  const seedBefore = readFileSync(sandbox.seedConfigPath, 'utf8');

  assert.throws(
    () => addAgentRunner(sandbox, {
      deps: {
        ...sandbox.deps,
        // Fail precisely at the atomic replacement of the registry manifest,
        // after the new project config has already been committed.
        renameFn: (from, to) => {
          if (to === sandbox.registryPath) throw new Error('simulated crash before registry replacement');
          return renameSync(from, to);
        },
      },
    }),
    (error) => error.code === 'mutation-apply-failed' && error.details.rolledBack === true,
  );

  assert.equal(readFileSync(sandbox.registryPath, 'utf8'), registryBefore, 'registry bytes unchanged');
  assert.equal(readFileSync(sandbox.seedConfigPath, 'utf8'), seedBefore, 'existing project config unchanged');
  assert.equal(
    existsSync(join(sandbox.registryDir, 'projects', 'agent-runner.json')),
    false,
    'the half-added project config was removed',
  );
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 1);

  const audit = readAudit(sandbox.auditPath);
  assert.equal(audit.at(-1).outcome, 'rolled-back');
  assert.equal(audit.at(-1).action, 'add');
}));

test('a registry that fails post-write revalidation is rolled back to the exact prior state', () => withSandbox((sandbox) => {
  const registryBefore = readFileSync(sandbox.registryPath, 'utf8');
  let loads = 0;

  assert.throws(
    () => addAgentRunner(sandbox, {
      deps: {
        ...sandbox.deps,
        loadRegistry: () => {
          loads += 1;
          throw new Error("Invalid agent runner project registry: duplicate projectId 'agent-runner' in a and b");
        },
      },
    }),
    (error) => error.code === 'duplicate-projectId' && error.details.rolledBack === true,
  );

  assert.equal(loads, 1);
  assert.equal(readFileSync(sandbox.registryPath, 'utf8'), registryBefore);
  assert.equal(existsSync(join(sandbox.registryDir, 'projects', 'agent-runner.json')), false);
}));

test('staging files left by an interrupted mutation are inert and are swept on the next mutation', () => withSandbox((sandbox) => {
  const strayRegistryTemp = join(sandbox.registryDir, '.agent-runner-registry-deadbeefdeadbeef.tmp');
  const strayProjectTemp = join(sandbox.registryDir, 'projects', '.agent-runner-registry-cafecafecafecafe.tmp');
  writeFileSync(strayRegistryTemp, '{"schemaVersion":1,"projects":[]}');
  writeFileSync(strayProjectTemp, '{partial');

  // The previous valid registry is completely unaffected by the leftovers.
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 1);
  assert.equal(listProjects({ env: sandbox.env }).registryValid, true);

  addAgentRunner(sandbox);
  assert.equal(existsSync(strayRegistryTemp), false);
  assert.equal(existsSync(strayProjectTemp), false);
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 1);

  // The sweep is bounded to staging files: nothing else is removed.
  const swept = sweepStaleRegistryTempFiles({
    registryDir: sandbox.registryDir,
    projectsDir: join(sandbox.registryDir, 'projects'),
    archiveDir: join(sandbox.registryDir, 'archived-projects'),
  });
  assert.deepEqual(swept, []);
  assert.equal(existsSync(sandbox.registryPath), true);
  assert.equal(existsSync(sandbox.seedConfigPath), true);
}));

test('management reads and mutations perform read-only git inspection only and no GitHub call', () => withSandbox((sandbox) => {
  addAgentRunner(sandbox, { enable: true });
  setProjectEnabled({ env: sandbox.env, projectId: 'agent-runner', enabled: false });
  listProjects({ env: sandbox.env, verbose: true });
  validateRegistry({ env: sandbox.env });
  removeProject({ env: sandbox.env, projectId: 'agent-runner' });

  assert.ok(sandbox.gitCalls.length > 0, 'the local checkout was inspected');
  for (const call of sandbox.gitCalls) {
    assert.equal(call[0], '-C');
    const verb = call[2];
    assert.ok(['rev-parse', 'config'].includes(verb), `unexpected git verb: ${verb}`);
    assert.equal(call.some((arg) => /clone|push|fetch|remote add|commit|checkout|branch|tag/.test(arg)), false);
  }
  // Only `add` inspects a checkout; enable/disable/remove/list never shell out.
  assert.equal(sandbox.gitCalls.length, 2);
}));

test('bounded views expose no machine paths or config contents unless verbose is requested', () => withSandbox((sandbox) => {
  addAgentRunner(sandbox, { enable: true });

  const view = listProjects({ env: sandbox.env });
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(sandbox.home), false, 'no machine paths in the reusable JSON contract');
  assert.equal(serialized.includes('.sqlite'), false);
  assert.equal(serialized.includes('cron.lock'), false);
  for (const key of ['token', 'secret', 'credential', 'env', 'prompt', 'apiKey', 'acceptedAgentLabels', 'systemd']) {
    assert.equal(serialized.includes(key), false, `restricted field leaked: ${key}`);
  }
  assert.deepEqual(Object.keys(view.projects[0]).sort(), [
    'admissionReason', 'checkoutReady', 'configReason', 'configValid', 'displayName', 'enabled',
    'githubRepo', 'isDefault', 'projectId', 'registryAdmitted', 'schedulerEligibilityReason',
    'schedulerEligible', 'stateInitialized',
  ].sort());

  const verbose = listProjects({ env: sandbox.env, verbose: true });
  assert.equal(verbose.projects[0].localRepoPath, sandbox.modelspendCheckout);
  assert.ok(verbose.projects[0].stateDbPath.endsWith('runner-state.sqlite'));
}));

test('successful mutations record bounded audit evidence and refusals are recorded without state change', () => withSandbox((sandbox) => {
  addAgentRunner(sandbox);
  setProjectEnabled({ env: sandbox.env, projectId: 'agent-runner', enabled: true });
  setProjectEnabled({ env: sandbox.env, projectId: 'agent-runner', enabled: false });
  assert.throws(() => removeProject({ env: sandbox.env, projectId: 'modelspend' }));
  removeProject({ env: sandbox.env, projectId: 'agent-runner' });

  const audit = readAudit(sandbox.auditPath);
  assert.deepEqual(audit.map((entry) => entry.action), ['add', 'enable', 'disable', 'remove', 'remove']);
  assert.deepEqual(audit.map((entry) => entry.outcome), ['ok', 'ok', 'ok', 'refused', 'ok']);
  assert.equal(audit.filter((entry) => entry.outcome === 'refused')[0].reason, 'default-project-required');

  for (const entry of audit) {
    assert.ok(entry.at && entry.actor && entry.source === 'operator-cli');
    assert.ok(entry.projectId, 'every audited mutation names its project');
    assert.deepEqual(Object.keys(entry).sort(), [
      'action', 'actor', 'afterDigest', 'at', 'beforeDigest', 'githubRepo', 'id',
      'outcome', 'projectId', 'reason', 'schemaVersion', 'source',
    ].sort());
    const serialized = JSON.stringify(entry);
    assert.equal(serialized.includes(sandbox.home), false, 'audit must not record machine paths');
    assert.equal(serialized.includes('acceptedAgentLabels'), false, 'audit must not record config contents');
  }
  const applied = audit.filter((entry) => entry.outcome === 'ok');
  for (const entry of applied) {
    assert.ok(entry.githubRepo, 'an applied mutation records the repository it admitted or withdrew');
    assert.match(entry.beforeDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(entry.afterDigest, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(entry.beforeDigest, entry.afterDigest);
  }
}));

test('enable can repair a registry that currently admits no project', () => withSandbox((sandbox) => {
  // A registry with zero enabled projects is invalid for the runtime, but the
  // management contract must still be able to fix it rather than dead-end.
  assert.throws(() => loadProjectRegistry({ registryPath: sandbox.registryPath }), /at least one project must be enabled/);
  assert.equal(listProjects({ env: sandbox.env }).registryReason, 'no-enabled-project');

  setProjectEnabled({ env: sandbox.env, projectId: 'modelspend', enabled: true });
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 1);
}, { seedEnabled: false, defaultProjectId: null }));

test('generated project config and checkout inspection helpers behave deterministically', () => {
  const config = buildManagedProjectConfig({
    projectId: 'demo',
    githubRepo: 'Owner/Demo',
    localRepoPath: '/srv/demo/../demo',
    env: { HOME: '/home/tester' },
  });
  assert.equal(config.localRepoPath, '/srv/demo');
  assert.equal(config.outputDir, '/home/tester/.local/state/agent-runner/demo');
  assert.equal(config.displayName, 'demo');
  assert.equal(config.systemd.timerName, 'agent-runner-demo.timer');

  assert.equal(parseGitRemoteRepository('git@github.com:Owner/Repo.git'), 'Owner/Repo');
  assert.equal(parseGitRemoteRepository('https://github.com/Owner/Repo'), 'Owner/Repo');
  assert.equal(parseGitRemoteRepository(''), null);

  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-checkout-'));
  try {
    assert.deepEqual(
      inspectLocalCheckout({ localRepoPath: dir, githubRepo: 'Owner/Repo', allowMissingCheckout: true }),
      { present: false, checkoutReady: false, repositoryVerified: false, remoteRepository: null },
    );
    mkdirSync(join(dir, '.git'));
    const inspected = inspectLocalCheckout({
      localRepoPath: dir,
      githubRepo: 'owner/repo',
      deps: { runGit: (args) => (args.includes('--is-inside-work-tree') ? 'true' : 'https://github.com/Owner/Repo.git') },
    });
    assert.equal(inspected.checkoutReady, true);
    assert.equal(inspected.repositoryVerified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
