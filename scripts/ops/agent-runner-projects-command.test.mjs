import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main as cliMain } from './agent-runner-cli.mjs';
import { main as projectsMain, parseProjectsArgs, usageText } from './agent-runner-projects-command.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';

function collectingIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: (chunk) => err.push(chunk) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function seedConfig(projectId, githubRepo, localRepoPath) {
  return {
    projectId,
    displayName: `${projectId} fixture`,
    githubRepo,
    localRepoPath,
    outputDir: '.var/agent-runner',
    stateDbPath: '.var/agent-runner/runner-state.sqlite',
    acceptedAgentLabels: ['agent:claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0', 'priority:P1'],
    safeDefaultValidationCommands: ['npm test'],
    systemd: { serviceName: `${projectId}.service`, timerName: `${projectId}.timer` },
    runner: { lockPath: '.var/agent-runner/cron.lock', candidateLimit: 50 },
  };
}

async function withSandbox(fn) {
  const home = mkdtempSync(join(tmpdir(), 'agent-runner-projects-cli-'));
  try {
    const registryDir = join(home, '.config', 'agent-runner');
    const registryPath = join(registryDir, 'projects.json');
    mkdirSync(join(registryDir, 'projects'), { recursive: true });
    const modelspendCheckout = join(home, 'workspace', 'modelspend');
    const agentRunnerCheckout = join(home, 'workspace', 'agent-runner');
    for (const checkout of [modelspendCheckout, agentRunnerCheckout]) mkdirSync(join(checkout, '.git'), { recursive: true });
    writeFileSync(
      join(registryDir, 'projects', 'modelspend.json'),
      `${JSON.stringify(seedConfig('modelspend', 'TheTekTeam/modelspend', modelspendCheckout), null, 2)}\n`,
    );
    writeFileSync(registryPath, `${JSON.stringify({
      schemaVersion: 1,
      defaultProjectId: 'modelspend',
      projects: [{ configPath: 'projects/modelspend.json', enabled: true }],
    }, null, 2)}\n`);

    const runGit = (args) => (args.includes('--is-inside-work-tree')
      ? 'true'
      : 'git@github.com:TheTekTeam/agent-runner.git');

    return await fn({
      home,
      env: { HOME: home },
      registryDir,
      registryPath,
      modelspendCheckout,
      agentRunnerCheckout,
      deps: { storeDeps: { runGit } },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function run(sandbox, argv, extraDeps = {}) {
  const capture = collectingIo();
  const code = await projectsMain(argv, sandbox.env, capture.io, { ...sandbox.deps, ...extraDeps });
  return { code, stdout: capture.stdout(), stderr: capture.stderr() };
}

const ADD_ARGS = (sandbox) => [
  'add',
  '--project-id', 'agent-runner',
  '--repo', 'TheTekTeam/agent-runner',
  '--local-path', sandbox.agentRunnerCheckout,
  '--display-name', 'Agent Runner',
];

test('refuses to run as root before touching the registry', () => withSandbox(async (sandbox) => {
  const before = readFileSync(sandbox.registryPath, 'utf8');
  const result = await run(sandbox, ADD_ARGS(sandbox), { getuid: () => 0 });
  assert.equal(result.code, 2);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, reason: 'root-not-permitted' });
  assert.equal(result.stdout, '');
  assert.equal(readFileSync(sandbox.registryPath, 'utf8'), before);
  assert.equal(existsSync(join(sandbox.registryDir, 'projects', 'agent-runner.json')), false);
}));

test('prints usage for no subcommand and rejects unknown subcommands and arguments', () => withSandbox(async (sandbox) => {
  const help = await run(sandbox, []);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /agent-runner projects <subcommand>/);
  assert.match(usageText(), /never deletes|never deleted/);

  const unknown = await run(sandbox, ['teleport']);
  assert.equal(unknown.code, 2);
  assert.equal(JSON.parse(unknown.stderr).reason, 'Unknown projects subcommand: teleport');

  const badArg = await run(sandbox, ['list', '--wat']);
  assert.equal(badArg.code, 2);
  assert.equal(JSON.parse(badArg.stderr).reason, 'Unknown argument: --wat');

  const missingValue = await run(sandbox, ['add', '--project-id']);
  assert.equal(missingValue.code, 2);
  assert.equal(JSON.parse(missingValue.stderr).reason, '--project-id requires a value');
}));

test('parses positional ids, valued flags and --flag=value forms', () => {
  assert.deepEqual(parseProjectsArgs(['enable', 'alpha', '--json']), {
    subcommand: 'enable',
    positional: ['alpha'],
    options: { json: true, verbose: false, enable: false, allowMissingCheckout: false },
  });
  assert.equal(parseProjectsArgs(['list', '--registry=/tmp/r.json']).options.registry, '/tmp/r.json');
  assert.equal(parseProjectsArgs(['list', '--nope=1']).error, 'Unknown argument: --nope');
});

test('add through the CLI registers a disabled project and enable/disable/remove drive the same contract', () => withSandbox(async (sandbox) => {
  const added = await run(sandbox, [...ADD_ARGS(sandbox), '--json']);
  assert.equal(added.code, 0);
  const addPayload = JSON.parse(added.stdout);
  assert.equal(addPayload.ok, true);
  assert.equal(addPayload.action, 'add');
  assert.equal(addPayload.details.enabled, false);
  assert.deepEqual(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.map((p) => p.projectId), ['modelspend']);

  const enabled = await run(sandbox, ['enable', 'agent-runner', '--json']);
  assert.equal(enabled.code, 0);
  assert.equal(JSON.parse(enabled.stdout).changed, true);
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 2);

  const disabled = await run(sandbox, ['disable', 'agent-runner']);
  assert.equal(disabled.code, 0);
  assert.match(disabled.stdout, /disable: applied for agent-runner/);
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 1);

  const configPath = join(sandbox.registryDir, 'projects', 'agent-runner.json');
  const configBefore = readFileSync(configPath, 'utf8');
  const removed = await run(sandbox, ['remove', 'agent-runner', '--json']);
  assert.equal(removed.code, 0);
  assert.equal(JSON.parse(removed.stdout).details.statePreserved, true);
  assert.equal(
    readFileSync(join(sandbox.registryDir, 'archived-projects', 'agent-runner.json'), 'utf8'),
    configBefore,
    'remove archives the config instead of deleting it',
  );
  assert.equal(existsSync(join(sandbox.agentRunnerCheckout, '.git')), true, 'remove never touches the checkout');
}));

test('add --enable admits immediately and set-default retargets the default project', () => withSandbox(async (sandbox) => {
  assert.equal((await run(sandbox, [...ADD_ARGS(sandbox), '--enable'])).code, 0);
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 2);

  const setDefault = await run(sandbox, ['set-default', 'agent-runner', '--json']);
  assert.equal(setDefault.code, 0);
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).defaultProjectId, 'agent-runner');
}));

test('list and show JSON expose the bounded dashboard-safe contract only', () => withSandbox(async (sandbox) => {
  await run(sandbox, [...ADD_ARGS(sandbox), '--enable']);

  const listed = await run(sandbox, ['list', '--json']);
  assert.equal(listed.code, 0);
  const payload = JSON.parse(listed.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.schemaVersion, 'agent-runner-project-registry-view/v1');
  assert.equal(payload.projects.length, 2);
  assert.equal(listed.stdout.includes(sandbox.home), false, 'no machine paths in default JSON output');
  for (const restricted of ['token', 'secret', 'credential', 'password', 'prompt', '.sqlite', 'cron.lock', 'systemd']) {
    assert.equal(listed.stdout.includes(restricted), false, `restricted field leaked: ${restricted}`);
  }

  const shown = await run(sandbox, ['show', 'agent-runner', '--json']);
  assert.equal(JSON.parse(shown.stdout).project.githubRepo, 'TheTekTeam/agent-runner');
  assert.equal(shown.stdout.includes(sandbox.home), false);

  // Only an explicit local --verbose reveals canonical machine paths.
  const verbose = await run(sandbox, ['show', 'agent-runner', '--json', '--verbose']);
  assert.equal(verbose.stdout.includes(sandbox.home), true);

  const text = await run(sandbox, ['list']);
  assert.match(text.stdout, /registry: valid/);
  assert.match(text.stdout, /agent-runner\tTheTekTeam\/agent-runner\tenabled/);
}));

test('failures report a bounded reason code and never leak raw paths by default', () => withSandbox(async (sandbox) => {
  const missing = await run(sandbox, ['add', '--project-id', 'x']);
  assert.equal(missing.code, 1);
  const payload = JSON.parse(missing.stderr);
  assert.equal(payload.reason, 'missing-required-fields');
  assert.deepEqual(payload.details.missing, ['githubRepo', 'localRepoPath']);
  assert.equal(payload.message, undefined);
  assert.equal(missing.stderr.includes(sandbox.home), false);

  const notFound = await run(sandbox, ['enable', 'nope']);
  assert.equal(notFound.code, 1);
  assert.deepEqual(JSON.parse(notFound.stderr), {
    ok: false,
    reason: 'project-not-found',
    details: { projectId: 'nope' },
  });

  const lastProject = await run(sandbox, ['remove', 'modelspend']);
  assert.equal(lastProject.code, 1);
  assert.equal(JSON.parse(lastProject.stderr).reason, 'registry-would-be-empty');

  await run(sandbox, [...ADD_ARGS(sandbox)]);
  const defaultRemoval = await run(sandbox, ['remove', 'modelspend']);
  assert.equal(defaultRemoval.code, 1);
  assert.equal(JSON.parse(defaultRemoval.stderr).reason, 'default-project-required');
  assert.equal(loadProjectRegistry({ registryPath: sandbox.registryPath }).projects.length, 1);

  const verbose = await run(sandbox, ['enable', 'nope', '--verbose']);
  assert.match(JSON.parse(verbose.stderr).message, /is not registered/);
}));

test('validate exits non-zero for an invalid registry and zero for a valid one', () => withSandbox(async (sandbox) => {
  const valid = await run(sandbox, ['validate', '--json']);
  assert.equal(valid.code, 0);
  assert.equal(JSON.parse(valid.stdout).ok, true);
  assert.equal(JSON.parse(valid.stdout).enabledCount, 1);

  writeFileSync(join(sandbox.registryDir, 'projects', 'modelspend.json'), '{broken');
  const invalid = await run(sandbox, ['validate', '--json']);
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stdout).ok, false);
  assert.equal(JSON.parse(invalid.stdout).reason, 'config-malformed-json');
}));

test('--registry selects an explicit registry file without touching the default one', () => withSandbox(async (sandbox) => {
  const otherDir = join(sandbox.home, 'elsewhere');
  mkdirSync(otherDir, { recursive: true });
  const otherRegistry = join(otherDir, 'projects.json');
  writeFileSync(otherRegistry, `${JSON.stringify({
    schemaVersion: 1,
    defaultProjectId: 'modelspend',
    projects: [{ configPath: join(sandbox.registryDir, 'projects', 'modelspend.json'), enabled: true }],
  }, null, 2)}\n`);
  const defaultBefore = readFileSync(sandbox.registryPath, 'utf8');

  const result = await run(sandbox, [...ADD_ARGS(sandbox), '--registry', otherRegistry, '--json']);
  assert.equal(result.code, 0);
  assert.equal(readFileSync(sandbox.registryPath, 'utf8'), defaultBefore, 'the default registry is untouched');
  assert.equal(existsSync(join(otherDir, 'projects', 'agent-runner.json')), true);
}));

test('the consolidated operator CLI routes projects subcommands and advertises them', async () => {
  const capture = collectingIo();
  const code = await cliMain(['projects', 'list', '--json'], { HOME: '/nonexistent-agent-runner-home' }, capture.io, {
    projectsMain: async (argv, env, io) => {
      io.stdout.write(JSON.stringify({ ok: true, routed: argv }));
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(capture.stdout()), { ok: true, routed: ['list', '--json'] });

  const help = collectingIo();
  await cliMain([], {}, help.io, {});
  assert.match(help.stdout(), /projects <list\|show\|add\|enable\|disable\|remove\|set-default\|validate>/);
});
