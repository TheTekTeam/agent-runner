import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertProjectScopedEnv } from './agent-runner-config.mjs';
import {
  acquireImplementationSlot,
  IMPLEMENTATION_LANE_ENV,
  resolveImplementationLaneLockPath,
  sanitizeImplementationLane,
  SLOT_INVALID_LANE,
} from './agent-runner-implementation-slot.mjs';
import {
  buildProjectScopedInvocationEnv,
  classifyProbeOutcome,
  implementationLaneForSelection,
  loadEnabledProjectsWithConfigPaths,
  NO_RUNNABLE_CANDIDATE_EXIT_CODE,
  resolveEvidenceDir,
  resolveGlobalLockPath,
  resolveMaxParallel,
  runImplementationRecurrence,
  selectRunnableProject,
  selectRunnableProjects,
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

function fakeLock(events = []) {
  return (path) => {
    events.push(`lock:${path}`);
    return () => events.push(`release:${path}`);
  };
}

function noopEvidence(evidenceDir, payload) {
  return `${evidenceDir}/stub-${payload.selectedProjectId || 'none'}.json`;
}

test('probe classification preserves runnable, idle and blocked semantics', () => {
  assert.deepEqual(classifyProbeOutcome({ status: 0, payload: { selectedIssue: 42 } }), {
    runnable: true, blocked: false, reason: 'runnable-candidate', selectedIssue: 42,
  });
  assert.equal(classifyProbeOutcome({ status: NO_RUNNABLE_CANDIDATE_EXIT_CODE }).reason, 'no-runnable-candidate');
  assert.equal(classifyProbeOutcome({ status: 17 }).reason, 'probe-failed-exit-17');
});

test('historical selectRunnableProject remains first-runnable compatible', () => {
  const projects = [
    { config: { projectId: 'alpha', githubRepo: 'Owner/Alpha' } },
    { config: { projectId: 'beta', githubRepo: 'Owner/Beta' } },
  ];
  const result = selectRunnableProject(projects, {
    probeProject: (entry) => entry.config.projectId === 'beta'
      ? { status: 0, payload: { selectedIssue: 7 } }
      : { status: NO_RUNNABLE_CANDIDATE_EXIT_CODE },
  });
  assert.equal(result.selected.config.projectId, 'beta');
  assert.equal(result.probed.length, 2);
});

test('selectRunnableProjects keeps all independent runnable projects up to the cap', () => {
  const projects = ['alpha', 'beta', 'gamma'].map((projectId) => ({
    config: { projectId, githubRepo: `Owner/${projectId}` },
  }));
  const result = selectRunnableProjects(projects, {
    maxParallel: 2,
    probeProject: (entry) => ({ status: 0, payload: { selectedIssue: entry.config.projectId.length } }),
  });
  assert.deepEqual(result.selected.map(({ entry }) => entry.config.projectId), ['alpha', 'beta']);
  assert.equal(result.probed.length, 3, 'all projects are still probed for truthful evidence');
});

test('a project-local blocker does not stop another runnable project', () => {
  const projects = [
    { config: { projectId: 'alpha', githubRepo: 'Owner/Alpha' } },
    { config: { projectId: 'beta', githubRepo: 'Owner/Beta' } },
  ];
  const result = selectRunnableProjects(projects, {
    maxParallel: 2,
    probeProject: (entry) => entry.config.projectId === 'alpha'
      ? { status: 9 }
      : { status: 0, payload: { selectedIssue: 11 } },
  });
  assert.deepEqual(result.selected.map(({ entry }) => entry.config.projectId), ['beta']);
  assert.equal(result.probed[0].blocked, true);
});

test('max parallel defaults to runnable capacity and validates explicit bounds', () => {
  assert.equal(resolveMaxParallel({}, 3), 3);
  assert.equal(resolveMaxParallel({ AGENT_RUNNER_MAX_PARALLEL: '4' }, 20), 4);
  assert.throws(() => resolveMaxParallel({ AGENT_RUNNER_MAX_PARALLEL: '0' }, 3), /between 1 and 64/);
  assert.throws(() => resolveMaxParallel({ AGENT_RUNNER_MAX_PARALLEL: 'many' }, 3), /positive integer/);
});

test('issue-scoped lane identity is deterministic and refuses missing issue identity', () => {
  const entry = { config: { projectId: 'modelspend' } };
  assert.equal(implementationLaneForSelection(entry, { selectedIssue: 792 }), 'modelspend:issue:792');
  assert.throws(() => implementationLaneForSelection(entry, { selectedIssue: null }), /valid selected issue/);
});

test('explicit implementation lanes resolve to independent lock paths while legacy callers keep the global lock', () => {
  const base = { HOME: '/home/op' };
  assert.equal(resolveImplementationLaneLockPath(base), '/home/op/.local/state/agent-runner/implementation-recurrence.lock');
  assert.equal(
    resolveImplementationLaneLockPath({ ...base, [IMPLEMENTATION_LANE_ENV]: 'modelspend:issue:792' }),
    '/home/op/.local/state/agent-runner/implementation-lanes/modelspend-issue-792.lock',
  );
  assert.notEqual(
    resolveImplementationLaneLockPath({ ...base, [IMPLEMENTATION_LANE_ENV]: 'modelspend:issue:792' }),
    resolveImplementationLaneLockPath({ ...base, [IMPLEMENTATION_LANE_ENV]: 'agent-runner:issue:314' }),
  );
});

test('lane sanitization fails closed for unsafe or oversized identities', () => {
  assert.equal(sanitizeImplementationLane('agent-runner:issue:314'), 'agent-runner-issue-314');
  assert.equal(sanitizeImplementationLane('../../bad lane'), null);
  assert.equal(sanitizeImplementationLane('x'.repeat(181)), null);
  const result = acquireImplementationSlot({
    env: { HOME: '/home/op', [IMPLEMENTATION_LANE_ENV]: '../../bad lane' },
    acquireLock: () => { throw new Error('must not be reached'); },
  });
  assert.equal(result.held, false);
  assert.equal(result.failureReason, SLOT_INVALID_LANE);
});

test('different exact lanes can acquire independently while the same lane remains collision protected', () => {
  const locked = new Set();
  const acquireLock = (path) => {
    if (locked.has(path)) throw new Error('held');
    locked.add(path);
    return () => locked.delete(path);
  };
  const oneEnv = { HOME: '/home/op', [IMPLEMENTATION_LANE_ENV]: 'alpha:issue:1' };
  const twoEnv = { HOME: '/home/op', [IMPLEMENTATION_LANE_ENV]: 'beta:issue:2' };
  const one = acquireImplementationSlot({ env: oneEnv, acquireLock });
  const two = acquireImplementationSlot({ env: twoEnv, acquireLock });
  const duplicate = acquireImplementationSlot({ env: oneEnv, acquireLock });
  assert.equal(one.held, true);
  assert.equal(two.held, true);
  assert.equal(duplicate.held, false);
  one.release();
  two.release();
});

test('buildProjectScopedInvocationEnv scrubs prior project and slot identity and binds only the selected lane', () => {
  const inherited = {
    HOME: '/home/op',
    GITHUB_REPOSITORY: 'TheTekTeam/modelspend',
    CLAUDE_RUNNER_OUTPUT_DIR: '/srv/modelspend/.var',
    AGENT_RUNNER_IMPLEMENTATION_SLOT_PID: '123',
    AGENT_RUNNER_IMPLEMENTATION_LANE: 'old:issue:1',
    UNRELATED_MACHINE_POLICY: 'kept',
  };
  const result = buildProjectScopedInvocationEnv(inherited, '/srv/agent-runner/config.json', {
    laneId: 'agent-runner:issue:314',
  });
  assert.equal(result.GITHUB_REPOSITORY, undefined);
  assert.equal(result.CLAUDE_RUNNER_OUTPUT_DIR, undefined);
  assert.equal(result.AGENT_RUNNER_IMPLEMENTATION_SLOT_PID, undefined);
  assert.equal(result.AGENT_RUNNER_IMPLEMENTATION_LANE, 'agent-runner:issue:314');
  assert.equal(result.AGENT_RUNNER_CONFIG, '/srv/agent-runner/config.json');
  assert.equal(result.CLAUDE_RUNNER_CONFIG, '/srv/agent-runner/config.json');
  assert.equal(result.UNRELATED_MACHINE_POLICY, 'kept');
});

test('selected project binding still satisfies the project identity gate', () => {
  const config = projectConfig('agent-runner', 'TheTekTeam/agent-runner', '/srv/agent-runner');
  const configPath = '/home/op/.config/agent-runner/agent-runner.json';
  const env = buildProjectScopedInvocationEnv({
    HOME: '/home/op',
    GITHUB_REPOSITORY: 'TheTekTeam/modelspend',
  }, configPath, { laneId: 'agent-runner:issue:314' });
  assert.doesNotThrow(() => assertProjectScopedEnv({ config, configPath, env }));
});

test('disabled projects are excluded before probing', () => withRegistry(
  {
    'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend'),
    'agent-runner.json': projectConfig('agent-runner', 'TheTekTeam/agent-runner', '/srv/agent-runner', { enabled: false }),
  },
  { schemaVersion: 1, defaultProjectId: 'modelspend', projects: [{ configPath: 'modelspend.json', enabled: true }, { configPath: 'agent-runner.json', enabled: false }] },
  (registryPath) => {
    const { projects } = loadEnabledProjectsWithConfigPaths({ registryPath });
    assert.deepEqual(projects.map(({ config }) => config.projectId), ['modelspend']);
  },
));

test('invalid registry fails before scheduler lock acquisition', () => withRegistry(
  { 'modelspend.json': projectConfig('modelspend', 'TheTekTeam/modelspend', '/srv/modelspend') },
  '{"schemaVersion":1,"projects":[]}',
  async (registryPath) => {
    let locked = false;
    await assert.rejects(
      () => runImplementationRecurrence({
        registryPath,
        acquireLock: () => { locked = true; return () => {}; },
        probeProject: () => ({ status: 0 }),
      }),
      /Invalid agent runner project registry/,
    );
    assert.equal(locked, false);
  },
));

test('Dell scheduler lock is released before worker invocations and two projects execute concurrently', () => withRegistry(
  {
    'alpha.json': projectConfig('alpha', 'Owner/alpha', '/srv/alpha'),
    'beta.json': projectConfig('beta', 'Owner/beta', '/srv/beta'),
  },
  { schemaVersion: 1, defaultProjectId: 'alpha', projects: ['alpha.json', 'beta.json'] },
  async (registryPath) => {
    const events = [];
    let active = 0;
    let peak = 0;
    const result = await runImplementationRecurrence({
      registryPath,
      env: { HOME: '/home/op', AGENT_RUNNER_MAX_PARALLEL: '2' },
      acquireLock: fakeLock(events),
      probeProject: (entry) => ({ status: 0, payload: { selectedIssue: entry.config.projectId === 'alpha' ? 10 : 20 } }),
      invokeProject: async (entry, { laneId }) => {
        assert.ok(events.some((entryEvent) => entryEvent.startsWith('release:')), 'scheduler mutex must be released before execution');
        events.push(`start:${entry.config.projectId}:${laneId}`);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        active -= 1;
        events.push(`end:${entry.config.projectId}`);
        return { status: 0 };
      },
      writeEvidenceFile: noopEvidence,
      computeProfileShadow: () => ({ available: true, projects: [] }),
    });
    assert.equal(peak, 2);
    assert.equal(result.invoked, true);
    assert.equal(result.reason, 'candidates-selected-concurrently');
    assert.deepEqual(result.selectedProjects.map((entry) => entry.laneId), ['alpha:issue:10', 'beta:issue:20']);
    assert.ok(events.indexOf('end:alpha') > events.indexOf('start:beta:beta:issue:20'));
  },
));

test('parallel cap restricts execution without hiding probe evidence', () => withRegistry(
  {
    'alpha.json': projectConfig('alpha', 'Owner/alpha', '/srv/alpha'),
    'beta.json': projectConfig('beta', 'Owner/beta', '/srv/beta'),
  },
  { schemaVersion: 1, defaultProjectId: 'alpha', projects: ['alpha.json', 'beta.json'] },
  async (registryPath) => {
    const invocations = [];
    const result = await runImplementationRecurrence({
      registryPath,
      env: { HOME: '/home/op', AGENT_RUNNER_MAX_PARALLEL: '1' },
      acquireLock: fakeLock(),
      probeProject: () => ({ status: 0, payload: { selectedIssue: 1 } }),
      invokeProject: (entry) => { invocations.push(entry.config.projectId); return { status: 0 }; },
      writeEvidenceFile: noopEvidence,
      computeProfileShadow: () => ({ available: true, projects: [] }),
    });
    assert.deepEqual(invocations, ['alpha']);
    assert.equal(result.probed.length, 2);
    assert.equal(result.selectedProjects.length, 1);
  },
));

test('no runnable project remains a zero-invocation healthy result', () => withRegistry(
  { 'alpha.json': projectConfig('alpha', 'Owner/alpha', '/srv/alpha') },
  { schemaVersion: 1, defaultProjectId: 'alpha', projects: ['alpha.json'] },
  async (registryPath) => {
    const result = await runImplementationRecurrence({
      registryPath,
      env: { HOME: '/home/op' },
      acquireLock: fakeLock(),
      probeProject: () => ({ status: NO_RUNNABLE_CANDIDATE_EXIT_CODE }),
      invokeProject: () => { throw new Error('must not invoke'); },
      writeEvidenceFile: noopEvidence,
      computeProfileShadow: () => ({ available: true, projects: [] }),
    });
    assert.equal(result.invoked, false);
    assert.deepEqual(result.selectedProjects, []);
    assert.equal(result.reason, 'no-runnable-project');
  },
));

test('scheduler lock and evidence paths remain backward-compatible and overridable', () => {
  assert.equal(resolveGlobalLockPath({ HOME: '/home/op' }), '/home/op/.local/state/agent-runner/implementation-recurrence.lock');
  assert.equal(resolveGlobalLockPath({ HOME: '/home/op', AGENT_RUNNER_IMPLEMENTATION_LOCK: '/tmp/custom.lock' }), '/tmp/custom.lock');
  assert.equal(resolveEvidenceDir({ HOME: '/home/op' }), '/home/op/.local/state/agent-runner/implementation-recurrence');
  assert.equal(resolveEvidenceDir({ HOME: '/home/op', AGENT_RUNNER_IMPLEMENTATION_EVIDENCE_DIR: '/tmp/evidence' }), '/tmp/evidence');
});
