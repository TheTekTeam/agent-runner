import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runManagementControlCycle } from './agent-runner-management-controller.mjs';
import {
  EXTERNAL_SCHEDULED_MANAGEMENT_TASKS,
  FIELD_ACCEPTANCE_PROBES,
  buildFieldAcceptanceReport,
} from './agent-runner-management-field-acceptance.mjs';
import {
  CUTOVER_GATES,
  EXTERNAL_RETIREMENT_GATE,
  buildCutoverReadiness,
  planManagementRollback,
} from './agent-runner-management-cutover.mjs';
import { runManagementControlCommand } from './agent-runner-management-control-command.mjs';
import {
  CLAIM_TOKEN,
  CONTROLLER_ID,
  PROJECT_ID,
  REGISTRY,
  REPOSITORY,
  SOURCE_SHA,
  T0,
  managementEvent,
  portFactory,
  setMode,
  withStores,
} from './agent-runner-management-test-fixtures.mjs';

function operatorEvidence(overrides = {}) {
  return {
    activeSourceSha: SOURCE_SHA,
    expectedSourceSha: SOURCE_SHA,
    controllerHost: 'dell',
    schedulerHost: 'dell',
    nonSchedulerHosts: [{ host: 'z790', schedulerEnabled: false }],
    implementationSlotCount: 1,
    authorityConsumedByWorker: true,
    lostWakeRecovered: true,
    ...overrides,
  };
}

async function reportFor({ operator = operatorEvidence(), prepare = null } = {}) {
  return withStores(async ({ eventStore, controlStore }) => {
    setMode(controlStore, 'active');
    eventStore.enqueue(managementEvent());
    const { resolvePorts } = portFactory();
    await runManagementControlCycle({
      eventStore,
      controlStore,
      registry: REGISTRY,
      controllerId: CONTROLLER_ID,
      claimToken: CLAIM_TOKEN,
      resolvePorts,
      now: () => T0,
    });
    if (prepare) prepare({ eventStore, controlStore });
    return buildFieldAcceptanceReport({ eventStore, controlStore, registry: REGISTRY, operator });
  });
}

test('there are twenty bounded probes with unique ids', () => {
  assert.equal(FIELD_ACCEPTANCE_PROBES.length, 20);
  const ids = FIELD_ACCEPTANCE_PROBES.map((probe) => probe.id);
  assert.equal(new Set(ids).size, 20);
});

test('the probes cover every required field-acceptance property', () => {
  const ids = FIELD_ACCEPTANCE_PROBES.map((probe) => probe.id);
  for (const id of [
    'exact-active-source', 'control-mode', 'one-manager-authority', 'dell-only-controller',
    'z790-not-scheduler', 'one-implementation-slot', 'registered-project-projections',
    'queue-idempotency', 'exact-worker-authority', 'authority-consumption',
    'pull-request-ci-wake', 'execution-to-programme-successor', 'assurance-read-only',
    'duplicate-event-dedupe', 'stale-replay-safe', 'restart-recovery', 'lost-wake-recovery',
    'delayed-not-before', 'quota-ambiguity-fails-closed', 'rollback-fencing',
  ]) {
    assert.ok(ids.includes(id), `missing probe: ${id}`);
  }
});

test('a real chain evidences the control-plane probes positively', async () => {
  const report = await reportFor();
  const byId = Object.fromEntries(report.probes.map((probe) => [probe.id, probe]));
  assert.equal(byId['exact-active-source'].status, 'pass');
  assert.equal(byId['control-mode'].status, 'pass');
  assert.equal(byId['one-manager-authority'].status, 'pass');
  assert.equal(byId['dell-only-controller'].status, 'pass');
  assert.equal(byId['z790-not-scheduler'].status, 'pass');
  assert.equal(byId['one-implementation-slot'].status, 'pass');
  assert.equal(byId['exact-worker-authority'].status, 'pass');
  assert.equal(byId['pull-request-ci-wake'].status, 'pass');
  assert.equal(byId['assurance-read-only'].status, 'pass');
  assert.equal(byId['restart-recovery'].status, 'pass');
});

test('a probe with no evidence reports not-evidenced rather than passing', async () => {
  const report = await reportFor({ operator: {} });
  const byId = Object.fromEntries(report.probes.map((probe) => [probe.id, probe]));
  assert.equal(byId['exact-active-source'].status, 'not-evidenced');
  assert.equal(byId['dell-only-controller'].status, 'not-evidenced');
  assert.equal(byId['lost-wake-recovery'].status, 'not-evidenced');
  assert.equal(byId['authority-consumption'].status, 'not-evidenced');
  // Absence of proof never counts as acceptance.
  assert.equal(report.accepted, false);
});

test('source drift, a second scheduler and a second slot each fail their probe', async () => {
  const drift = await reportFor({ operator: operatorEvidence({ activeSourceSha: 'c'.repeat(40) }) });
  assert.equal(drift.probes.find((probe) => probe.id === 'exact-active-source').status, 'fail');

  const secondScheduler = await reportFor({
    operator: operatorEvidence({ nonSchedulerHosts: [{ host: 'z790', schedulerEnabled: true }] }),
  });
  assert.equal(secondScheduler.probes.find((probe) => probe.id === 'z790-not-scheduler').status, 'fail');

  const twoSlots = await reportFor({ operator: operatorEvidence({ implementationSlotCount: 2 }) });
  assert.equal(twoSlots.probes.find((probe) => probe.id === 'one-implementation-slot').status, 'fail');

  const otherHost = await reportFor({ operator: operatorEvidence({ schedulerHost: 'z790' }) });
  assert.equal(otherHost.probes.find((probe) => probe.id === 'dell-only-controller').status, 'fail');
});

test('the report always states that this repository retired no external task', async () => {
  const report = await reportFor();
  assert.equal(report.externalScheduledTasks.retiredByThisRepository, false);
  assert.deepEqual([...report.externalScheduledTasks.tasks], [
    'ModelSpend Programme Manager',
    'Agent Runner Execution Manager',
    'ModelSpend Queue Oversight',
  ]);
});

test('the rollback-fencing probe recognises a recorded fence', async () => {
  const report = await reportFor({
    prepare: ({ controlStore }) => {
      controlStore.setControlMode({ mode: 'fenced', reason: 'rollback rehearsal', actor: 'operator-1' });
    },
  });
  assert.equal(report.probes.find((probe) => probe.id === 'rollback-fencing').status, 'pass');
});

test('the cutover gate set is explicit and never satisfied by inference', () => {
  const empty = buildCutoverReadiness({});
  assert.equal(empty.readyForExternalRetirement, false);
  assert.equal(empty.outstandingGateIds.length, CUTOVER_GATES.length);
  assert.equal(empty.externalScheduledTasksRetiredByThisRepository, false);
  assert.equal(empty.externalRetirementGate.id, EXTERNAL_RETIREMENT_GATE.id);
});

test('readiness requires every gate and a positive field-acceptance report', () => {
  const allGates = CUTOVER_GATES.map((gate) => gate.id);
  const withoutAcceptance = buildCutoverReadiness({ satisfiedGates: allGates });
  assert.equal(withoutAcceptance.readyForExternalRetirement, false);

  const negative = buildCutoverReadiness({ satisfiedGates: allGates, acceptanceReport: { accepted: false } });
  assert.equal(negative.readyForExternalRetirement, false);

  const positive = buildCutoverReadiness({ satisfiedGates: allGates, acceptanceReport: { accepted: true } });
  assert.equal(positive.readyForExternalRetirement, true);
  // Even then it only says the external action may be considered.
  assert.equal(positive.externalScheduledTasksRetiredByThisRepository, false);
});

test('an unknown cutover gate is refused', () => {
  assert.throws(() => buildCutoverReadiness({ satisfiedGates: ['external-scheduled-tasks-retired'] }), /unknown cutover gate/);
  assert.throws(() => buildCutoverReadiness({ satisfiedGates: ['invented-gate'] }), /unknown cutover gate/);
});

test('rollback always fences before any step that could re-enable legacy management', () => {
  const plan = planManagementRollback({ currentMode: 'active' });
  assert.equal(plan.steps[0].id, 'fence-event-manager');
  assert.equal(plan.steps[0].external, false);
  assert.equal(plan.invariant, 'fence-before-any-legacy-reenable');

  const reenable = plan.steps.find((step) => step.id === 'reenable-external-scheduled-tasks');
  assert.equal(reenable.external, true);
  assert.ok(reenable.order > plan.steps[0].order);
  // Every fencing/verification step precedes the external re-enable.
  for (const step of plan.steps.filter((entry) => entry.external === false)) {
    assert.ok(step.order < reenable.order, step.id);
  }
  assert.equal(plan.externalScheduledTasksRetiredByThisRepository, false);
  assert.deepEqual([...reenable.tasks], [...EXTERNAL_SCHEDULED_MANAGEMENT_TASKS]);
});

// ---------------------------------------------------------------- operator CLI

function projectConfig(projectId, githubRepo, localRepoPath) {
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
  };
}

function withCli(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-management-cli-'));
  try {
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(projectConfig(PROJECT_ID, REPOSITORY, join(dir, 'checkout'))));
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: ['fixture.json'] }));
    const dbPath = join(dir, 'controller.sqlite');
    const run = (argv) => {
      const out = [];
      const err = [];
      const exitCode = runManagementControlCommand(
        [...argv, '--project-registry', registryPath, '--db', dbPath],
        {},
        { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } },
      );
      return { exitCode, stdout: out.join(''), stderr: err.join('') };
    };
    return fn({ run, dir, dbPath, registryPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the CLI reports a bounded status and answers the operator questions', () => {
  withCli(({ run }) => {
    const result = run(['status']);
    assert.equal(result.exitCode, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.controlMode, 'disabled');
    assert.equal(status.managementRunning, false);
    assert.equal(status.mutationPermitted, false);
    assert.deepEqual(status.pendingEvents, []);
    assert.equal(status.ownerAttentionRequired, false);
  });
});

test('a control-mode change requires an explicit actor and reason and is audited', () => {
  withCli(({ run }) => {
    assert.equal(run(['mode', '--set', 'shadow']).exitCode, 2);
    assert.equal(run(['mode', '--set', 'enabled', '--actor', 'op', '--reason', 'x']).exitCode, 2);

    const changed = run(['mode', '--set', 'shadow', '--actor', 'operator-1', '--reason', 'begin shadow acceptance']);
    assert.equal(changed.exitCode, 0);
    const payload = JSON.parse(changed.stdout);
    assert.equal(payload.mode, 'shadow');
    assert.equal(payload.externalScheduledTasksChanged, false);
    assert.equal(JSON.parse(run(['status']).stdout).controlMode, 'shadow');
  });
});

test('the fence subcommand is rollback step one and changes no external task', () => {
  withCli(({ run }) => {
    run(['mode', '--set', 'active', '--actor', 'operator-1', '--reason', 'cutover rehearsal']);
    const fenced = run(['fence', '--actor', 'operator-1', '--reason', 'rollback rehearsal']);
    assert.equal(fenced.exitCode, 0);
    const payload = JSON.parse(fenced.stdout);
    assert.equal(payload.mode, 'fenced');
    assert.equal(payload.previousMode, 'active');
    assert.equal(payload.externalScheduledTasksChanged, false);
    assert.equal(JSON.parse(run(['status']).stdout).mutationPermitted, false);
  });
});

test('the CLI recover and field-acceptance subcommands are read-only and bounded', () => {
  withCli(({ run }) => {
    const recovered = run(['recover']);
    assert.equal(recovered.exitCode, 0);
    assert.equal(JSON.parse(recovered.stdout).dueCount, 0);

    const acceptance = run(['field-acceptance']);
    // Un-evidenced probes are not a tool failure; a positively failing one is.
    assert.equal(acceptance.exitCode, 0);
    const report = JSON.parse(acceptance.stdout);
    assert.equal(report.probes.length, 20);
    assert.equal(report.accepted, false);
    assert.equal(report.externalScheduledTasks.retiredByThisRepository, false);
  });
});

test('the CLI cutover subcommand needs no database and never retires an external task', () => {
  const out = [];
  const exitCode = runManagementControlCommand(['cutover'], {}, {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: () => {} },
  });
  assert.equal(exitCode, 0);
  const payload = JSON.parse(out.join(''));
  assert.equal(payload.readiness.readyForExternalRetirement, false);
  assert.equal(payload.rollback.steps[0].id, 'fence-event-manager');
});

test('the CLI refuses an unknown subcommand and prints usage', () => {
  const err = [];
  const exitCode = runManagementControlCommand(['retire-external-tasks'], {}, {
    stdout: { write: () => {} },
    stderr: { write: (text) => err.push(text) },
  });
  assert.equal(exitCode, 2);
  assert.match(err.join(''), /unknown subcommand/);
});
