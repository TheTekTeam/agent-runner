import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyProbeOutcome,
  loadEnabledProjectsWithConfigPaths,
  NO_RUNNABLE_CANDIDATE_EXIT_CODE,
  resolveEvidenceDir,
  resolveGlobalLockPath,
  runImplementationRecurrence,
  selectRunnableProject,
} from './agent-runner-implementation-recurrence.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-implementation-recurrence-'));
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

function fakeLock() {
  const calls = [];
  const acquireLock = (path) => {
    calls.push(path);
    return () => calls.push(`release:${path}`);
  };
  return { acquireLock, calls };
}

function noopEvidence(evidenceDir, payload) {
  return `${evidenceDir}/stub-${payload.selectedProjectId || 'none'}.json`;
}

test('classifyProbeOutcome maps exit 0 to a runnable candidate carrying its issue number', () => {
  assert.deepEqual(classifyProbeOutcome({ status: 0, payload: { selectedIssue: 42 } }), {
    runnable: true,
    blocked: false,
    reason: 'runnable-candidate',
    selectedIssue: 42,
  });
});

test('classifyProbeOutcome maps the candidate-probe no-runnable-candidate exit code to non-blocking idle', () => {
  const outcome = classifyProbeOutcome({ status: NO_RUNNABLE_CANDIDATE_EXIT_CODE, payload: null });
  assert.equal(outcome.runnable, false);
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.reason, 'no-runnable-candidate');
});

test('classifyProbeOutcome treats any other exit status as a project-local blocker, not "no work"', () => {
  const outcome = classifyProbeOutcome({ status: 1, payload: null });
  assert.equal(outcome.runnable, false);
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.reason, 'probe-failed-exit-1');
});

test('selectRunnableProject stops at the first runnable project in registry order', () => {
  const projects = [
    { config: { projectId: 'alpha', githubRepo: 'Owner/Alpha' } },
    { config: { projectId: 'beta', githubRepo: 'Owner/Beta' } },
  ];
  const probeProject = (entry) => (entry.config.projectId === 'beta' ? { status: 0, payload: { selectedIssue: 7 } } : { status: NO_RUNNABLE_CANDIDATE_EXIT_CODE });
  const { selected, probed } = selectRunnableProject(projects, { probeProject });
  assert.equal(selected.config.projectId, 'beta');
  assert.equal(probed.length, 2);
  assert.equal(probed[0].runnable, false);
  assert.equal(probed[1].runnable, true);
});

test('a project-local probe blocker does not permanently stop inspection of the next enabled project', () => {
  const projects = [
    { config: { projectId: 'alpha', githubRepo: 'Owner/Alpha' } },
    { config: { projectId: 'beta', githubRepo: 'Owner/Beta' } },
  ];
  const probeProject = (entry) => (entry.config.projectId === 'alpha' ? { status: 17 } : { status: 0, payload: { selectedIssue: 9 } });
  const { selected, probed } = selectRunnableProject(projects, { probeProject });
  assert.equal(selected.config.projectId, 'beta');
  assert.equal(probed[0].blocked, true);
  assert.equal(probed[0].runnable, false);
});

test('no enabled project with a runnable candidate is a healthy no-op with nothing selected', () => {
  const projects = [
    { config: { projectId: 'alpha', githubRepo: 'Owner/Alpha' } },
    { config: { projectId: 'beta', githubRepo: 'Owner/Beta' } },
  ];
  const probeProject = () => ({ status: NO_RUNNABLE_CANDIDATE_EXIT_CODE });
  const { selected, probed } = selectRunnableProject(projects, { probeProject });
  assert.equal(selected, null);
  assert.equal(probed.every((entry) => !entry.runnable), true);
});

test('disabled projects are excluded from the enabled project list and are never probed or selected', () => withRegistry(
  {
    'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend'),
    'agent-runner.json': projectConfig('agent-runner', 'TheTekTeam/agent-runner', '/srv/agent-runner', { enabled: false }),
  },
  { schemaVersion: 1, defaultProjectId: 'modelspend', projects: [{ configPath: 'modelspend.json', enabled: true }, { configPath: 'agent-runner.json', enabled: false }] },
  (registryPath) => {
    const { projects } = loadEnabledProjectsWithConfigPaths({ registryPath });
    assert.equal(projects.length, 1);
    assert.equal(projects[0].config.projectId, 'modelspend');
  },
));

test('an invalid registry fails before any lock is acquired', () => withRegistry(
  { 'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend') },
  '{"schemaVersion":1,"projects":[]}',
  async (registryPath) => {
    const { acquireLock, calls } = fakeLock();
    await assert.rejects(
      () => runImplementationRecurrence({ registryPath, acquireLock, probeProject: () => ({ status: 0 }) }),
      /Invalid agent runner project registry/,
    );
    assert.equal(calls.length, 0);
  },
));

test('ModelSpend runnable and Agent Runner idle selects ModelSpend and invokes it with its exact config path', () => withRegistry(
  {
    'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend'),
    'agent-runner.json': projectConfig('agent-runner', 'TheTekTeam/agent-runner', '/srv/agent-runner'),
  },
  { schemaVersion: 1, defaultProjectId: 'modelspend', projects: ['modelspend.json', 'agent-runner.json'] },
  async (registryPath) => {
    const { acquireLock } = fakeLock();
    const probeProject = (entry) => (entry.config.projectId === 'modelspend' ? { status: 0, payload: { selectedIssue: 100 } } : { status: NO_RUNNABLE_CANDIDATE_EXIT_CODE });
    const invocations = [];
    const invokeProject = (entry) => { invocations.push(entry.configPath); return { status: 0 }; };
    const result = await runImplementationRecurrence({
      registryPath, acquireLock, probeProject, invokeProject, writeEvidenceFile: noopEvidence,
    });
    assert.equal(result.selectedProjectId, 'modelspend');
    assert.equal(result.selectedIssue, 100);
    assert.equal(invocations.length, 1);
    assert.match(invocations[0], /modelspend\.json$/);
  },
));

test('Agent Runner runnable and ModelSpend blocked selects Agent Runner', () => withRegistry(
  {
    'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend'),
    'agent-runner.json': projectConfig('agent-runner', 'TheTekTeam/agent-runner', '/srv/agent-runner'),
  },
  { schemaVersion: 1, defaultProjectId: 'modelspend', projects: ['modelspend.json', 'agent-runner.json'] },
  async (registryPath) => {
    const { acquireLock } = fakeLock();
    const probeProject = (entry) => (entry.config.projectId === 'agent-runner' ? { status: 0, payload: { selectedIssue: 210 } } : { status: 9 });
    const invocations = [];
    const invokeProject = (entry) => { invocations.push(entry.config.projectId); return { status: 0 }; };
    const result = await runImplementationRecurrence({
      registryPath, acquireLock, probeProject, invokeProject, writeEvidenceFile: noopEvidence,
    });
    assert.equal(result.selectedProjectId, 'agent-runner');
    assert.deepEqual(invocations, ['agent-runner']);
  },
));

test('both projects runnable results in exactly one invocation', () => withRegistry(
  {
    'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend'),
    'agent-runner.json': projectConfig('agent-runner', 'TheTekTeam/agent-runner', '/srv/agent-runner'),
  },
  { schemaVersion: 1, defaultProjectId: 'modelspend', projects: ['modelspend.json', 'agent-runner.json'] },
  async (registryPath) => {
    const { acquireLock } = fakeLock();
    const probeProject = () => ({ status: 0, payload: { selectedIssue: 1 } });
    const invocations = [];
    const invokeProject = (entry) => { invocations.push(entry.config.projectId); return { status: 0 }; };
    const result = await runImplementationRecurrence({
      registryPath, acquireLock, probeProject, invokeProject, writeEvidenceFile: noopEvidence,
    });
    assert.equal(invocations.length, 1);
    assert.equal(result.selectedProjectId, 'modelspend');
  },
));

test('neither project runnable is a healthy no-op with zero invocation', () => withRegistry(
  {
    'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend'),
    'agent-runner.json': projectConfig('agent-runner', 'TheTekTeam/agent-runner', '/srv/agent-runner'),
  },
  { schemaVersion: 1, defaultProjectId: 'modelspend', projects: ['modelspend.json', 'agent-runner.json'] },
  async (registryPath) => {
    const { acquireLock } = fakeLock();
    let invoked = false;
    const probeProject = () => ({ status: NO_RUNNABLE_CANDIDATE_EXIT_CODE });
    const invokeProject = () => { invoked = true; return { status: 0 }; };
    const result = await runImplementationRecurrence({
      registryPath, acquireLock, probeProject, invokeProject, writeEvidenceFile: noopEvidence,
    });
    assert.equal(result.invoked, false);
    assert.equal(result.selectedProjectId, null);
    assert.equal(result.reason, 'no-runnable-project');
    assert.equal(invoked, false);
  },
));

test('the global lock is acquired once before probing and released after invocation, before any per-project work runs unlocked', () => withRegistry(
  {
    'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend'),
    'agent-runner.json': projectConfig('agent-runner', 'TheTekTeam/agent-runner', '/srv/agent-runner'),
  },
  { schemaVersion: 1, defaultProjectId: 'modelspend', projects: ['modelspend.json', 'agent-runner.json'] },
  async (registryPath) => {
    const { acquireLock, calls } = fakeLock();
    const probeProject = () => ({ status: 0, payload: { selectedIssue: 1 } });
    const invokeProject = () => ({ status: 0 });
    await runImplementationRecurrence({ registryPath, acquireLock, probeProject, invokeProject, writeEvidenceFile: noopEvidence });
    assert.equal(calls.length, 2);
    assert.match(calls[0], /implementation-recurrence\.lock$/);
    assert.match(calls[1], /^release:/);
  },
));

test('a duplicate concurrent recurrence is refused by a held lock before any probe runs', () => withRegistry(
  {
    'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend'),
  },
  { schemaVersion: 1, defaultProjectId: 'modelspend', projects: ['modelspend.json'] },
  async (registryPath) => {
    let probeCalls = 0;
    const acquireLock = () => { throw Object.assign(new Error('Runner lock is held by active or unverifiable process'), { code: 'AGENT_RUNNER_LOCKED' }); };
    const probeProject = () => { probeCalls += 1; return { status: 0 }; };
    await assert.rejects(
      () => runImplementationRecurrence({ registryPath, acquireLock, probeProject }),
      /AGENT_RUNNER_LOCKED|held by active/,
    );
    assert.equal(probeCalls, 0);
  },
));

test('project A configuration cannot be substituted for project B: each probe/invoke call is bound to its own config path', () => withRegistry(
  {
    'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend'),
    'agent-runner.json': projectConfig('agent-runner', 'TheTekTeam/agent-runner', '/srv/agent-runner'),
  },
  { schemaVersion: 1, defaultProjectId: 'modelspend', projects: ['modelspend.json', 'agent-runner.json'] },
  (registryPath) => {
    const { projects } = loadEnabledProjectsWithConfigPaths({ registryPath });
    const paths = projects.map((entry) => entry.configPath);
    assert.equal(new Set(paths).size, paths.length);
    for (const entry of projects) {
      assert.match(entry.configPath, new RegExp(`${entry.config.projectId}\\.json$`));
    }
  },
));

test('resolveGlobalLockPath defaults under the shared XDG state root and is overridable', () => {
  const defaultPath = resolveGlobalLockPath({ HOME: '/home/op' });
  assert.equal(defaultPath, '/home/op/.local/state/agent-runner/implementation-recurrence.lock');
  const overridden = resolveGlobalLockPath({ HOME: '/home/op', AGENT_RUNNER_IMPLEMENTATION_LOCK: '/tmp/custom.lock' });
  assert.equal(overridden, '/tmp/custom.lock');
});

test('resolveEvidenceDir defaults under the shared XDG state root and is overridable', () => {
  const defaultDir = resolveEvidenceDir({ HOME: '/home/op' });
  assert.equal(defaultDir, '/home/op/.local/state/agent-runner/implementation-recurrence');
  const overridden = resolveEvidenceDir({ HOME: '/home/op', AGENT_RUNNER_IMPLEMENTATION_EVIDENCE_DIR: '/tmp/evidence' });
  assert.equal(overridden, '/tmp/evidence');
});
