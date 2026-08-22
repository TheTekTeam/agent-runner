import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseManagementCycleOptions,
  resolveControllerIdentity,
  runManagementCycleCommand,
} from './agent-runner-management-cycle-command.mjs';
import { openManagementStores } from './agent-runner-management-control-store.mjs';
import { createProductionManagementPorts, parseCuratedIssueBody } from './agent-runner-management-collectors.mjs';
import { observeMaterialTransitions } from './agent-runner-management-observer.mjs';
import {
  ALLOWED_WAKE_UNITS,
  MANAGEMENT_WAKE_UNIT_ENV,
  createSystemdManagementWake,
} from './agent-runner-management-wake.mjs';
import { loadManagerProfileRegistry } from './agent-runner-manager-profile-registry.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';

/**
 * #268 production wiring. Every test below drives the *shipped* entrypoint and
 * the *shipped* collector factory. Only the outermost adapter surface -- git,
 * GitHub, quota, the implementation lock and host identity -- is faked, so what
 * is under test is the production path rather than a parallel one.
 */

const PROJECT_ID = 'agent-runner';
const REPOSITORY = 'TheTekTeam/agent-runner';
const SOURCE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'd'.repeat(40);
const DOC_SHA = 'b'.repeat(64);
const READY_ISSUE = 900;
const CURATION_KEY = 'qc:agent-runner:shadow-equivalence-evidence';
const T0 = '2026-08-22T09:00:00.000Z';

function projectConfig(localRepoPath) {
  return {
    projectId: PROJECT_ID,
    displayName: PROJECT_ID,
    githubRepo: REPOSITORY,
    localRepoPath,
    outputDir: '.var/agent-runner',
    stateDbPath: `.var/agent-runner/${PROJECT_ID}.sqlite`,
    acceptedAgentLabels: ['agent:claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0', 'priority:P1'],
    safeDefaultValidationCommands: ['npm test'],
    systemd: { serviceName: `${PROJECT_ID}.service`, timerName: `${PROJECT_ID}.timer` },
    runner: { lockPath: `.var/agent-runner/${PROJECT_ID}.lock`, candidateLimit: 20 },
  };
}

function readyIssueBody() {
  return [
    '<!-- agent-runner:queue-curation -->',
    `<!-- agent-runner:queue-curation-key: ${CURATION_KEY} -->`,
    '<!-- agent-runner:queue-dependencies:start -->',
    '## Depends on',
    '',
    '<!-- agent-runner:queue-dependencies:end -->',
  ].join('\n');
}

/** Bounded fake adapters: the only faked layer. */
function fakeAdapters(overrides = {}) {
  const calls = { mutation: [], authority: [], continuation: [] };
  const base = {
    readSourceSha: () => SOURCE_SHA,
    readInstructionDocument: () => ({ sha256: DOC_SHA, freshness: 'current' }),
    listOpenIssues: () => [{
      number: READY_ISSUE,
      title: 'Record bounded shadow equivalence evidence for the management control plane',
      state: 'open',
      labels: ['status:ready'],
      body: readyIssueBody(),
    }],
    listOpenPullRequests: () => [],
    readQuotaAdmission: ({ profileName }) => ({ state: 'available', profileName }),
    readImplementationSlot: () => ({ state: 'free', occupied: false }),
    readOwnership: () => ({ activeLeases: [], openPullRequests: [] }),
    readAttempt: () => null,
    readHosts: () => ({ controllerHost: 'dell', schedulerHost: 'dell', nonSchedulerHosts: [] }),
  };
  return { adapters: { ...base, ...overrides }, calls };
}

function activeAdapters(overrides = {}) {
  const { adapters, calls } = fakeAdapters(overrides);
  return {
    calls,
    adapters: {
      ...adapters,
      applyQueueMutationClient: () => ({
        createIssue: (request) => { calls.mutation.push(request.curationKey); return { number: 951 }; },
        updateIssueLabels: (request) => { calls.mutation.push(`labels-${request.issueNumber}`); return { ok: true }; },
        updateIssueDependencies: (request) => { calls.mutation.push(`deps-${request.issueNumber}`); return { ok: true }; },
      }),
      publishWorkerAuthority: ({ authority }) => calls.authority.push(authority.authorityKey),
      publishContinuationAuthority: ({ continuation }) => calls.continuation.push(continuation.continuationAuthorityKey),
    },
  };
}

async function withProduction(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-management-production-'));
  try {
    writeFileSync(join(dir, 'agent-runner.json'), JSON.stringify(projectConfig(join(dir, 'checkout'))));
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: ['agent-runner.json'] }));
    const registry = loadProjectRegistry({ registryPath });
    // The real checked-in manager profile, restricted to the one project this
    // temporary registry knows about.
    const profileRegistry = loadManagerProfileRegistry({
      entries: [{ projectId: PROJECT_ID, configPath: '../../config/manager-profiles/agent-runner.json' }],
      projectRegistry: registry,
    });
    const dbPath = join(dir, 'controller.sqlite');
    const options = {
      help: false, registryPath, dbPath, scope: 'global', controllerId: 'test-management-controller',
      maxEvents: 10, expectedSourceSha: SOURCE_SHA, observe: true, drain: true,
    };
    const setMode = (mode) => {
      const stores = openManagementStores(dbPath, { registry, now: () => T0 });
      try {
        stores.controlStore.setControlMode({ mode, reason: 'production wiring acceptance', actor: 'test-operator', now: T0 });
      } finally {
        stores.close();
      }
    };
    const openStores = () => openManagementStores(dbPath, { registry, now: () => T0 });
    // Awaited: the temporary state directory must outlive the asynchronous body,
    // or a later reopen would silently see a fresh, empty database.
    return await fn({ dir, registry, profileRegistry, options, dbPath, setMode, openStores });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run({ options, registry, profileRegistry, adapters, wake = null, overrides = {} }) {
  return runManagementCycleCommand({
    options: { ...options, ...overrides },
    registry,
    profileRegistry,
    adapters,
    wake,
    now: () => T0,
    uuid: () => '00000000-0000-4000-8000-000000000001',
  });
}

// ------------------------------------------------------------ entrypoint

test('the shipped entrypoint parses bounded options and refuses malformed ones', () => {
  const parsed = parseManagementCycleOptions(['--project-registry', '/tmp/registry.json', '--max-events', '5'], {});
  assert.equal(parsed.maxEvents, 5);
  assert.equal(parsed.observe, true);
  assert.equal(parsed.drain, true);
  assert.throws(() => parseManagementCycleOptions(['--max-events', '0'], {}), /--max-events/);
  assert.throws(() => parseManagementCycleOptions(['--expected-source-sha', 'nope'], {}), /exact 40-character/);
  assert.equal(parseManagementCycleOptions(['--observe-only'], {}).drain, false);
  assert.equal(parseManagementCycleOptions(['--no-observe'], {}).observe, false);
});

test('the controller identity is bounded and its claim token is fresh per run', () => {
  const first = resolveControllerIdentity({ controllerId: 'dell-management', uuid: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  assert.equal(first.controllerId, 'dell-management');
  assert.match(first.claimToken, /^mgmt-[0-9a-f]{32}$/);
  // An unsafe configured identity falls back rather than being persisted.
  assert.equal(resolveControllerIdentity({ controllerId: 'not a safe id!' }).controllerId, 'agent-runner-management-controller');
});

test('a disabled control plane observes nothing, drains nothing and exits cleanly', async () => {
  await withProduction(async (context) => {
    const { adapters } = fakeAdapters();
    const summary = await run({ ...context, adapters });
    assert.equal(summary.ran, false);
    assert.equal(summary.refusal, 'mode-disabled');
    assert.deepEqual(summary.observations, []);
    assert.equal(summary.cycle, null);
  });
});

test('a fenced control plane refuses to run at all', async () => {
  await withProduction(async (context) => {
    context.setMode('fenced');
    const { adapters } = fakeAdapters();
    const summary = await run({ ...context, adapters });
    assert.equal(summary.ran, false);
    assert.equal(summary.refusal, 'mode-fenced');
  });
});

// ------------------------------------------------------------ end to end

test('shadow mode runs the whole production chain: observe -> event -> controller -> handler -> settlement', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters, calls } = fakeAdapters();
    const summary = await run({ ...context, adapters });

    assert.equal(summary.ran, true);
    assert.equal(summary.mode, 'shadow');

    // 1. Live evidence was observed and durably enqueued.
    const [observation] = summary.observations;
    assert.equal(observation.observed, true);
    assert.ok(observation.transitions > 0, 'material transitions must be observed from live evidence');
    assert.ok(observation.enqueued > 0, 'observed change must durably enqueue at least one event');

    // 2. The controller drained them through the real collectors.
    assert.ok(summary.cycle.processed > 0, 'the controller must drain the enqueued events');
    const programme = summary.cycle.results.find((entry) => entry.role === 'programme');
    assert.ok(programme, 'programme reconciliation must have run');
    assert.equal(programme.settled, true);

    // 3. Shadow mutated nothing at all.
    assert.deepEqual(calls.mutation, []);
    assert.deepEqual(calls.authority, []);
    assert.deepEqual(calls.continuation, []);
    assert.equal(programme.mutationSuppressed, true);
  });
});

test('the shadow programme decision is computed from real validated evidence and recorded', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters } = fakeAdapters();
    await run({ ...context, adapters });

    const stores = context.openStores();
    try {
      const decision = stores.controlStore.listDecisions({ projectId: PROJECT_ID })
        .find((entry) => entry.role === 'programme');
      assert.ok(decision, 'a bounded programme decision must be recorded');
      assert.equal(decision.controlMode, 'shadow');
      assert.equal(decision.mutationSuppressed, true);
      // The live ready record was genuinely selected and an authority computed.
      assert.equal(decision.outcome, 'execution-required');
      assert.equal(decision.issueNumber, READY_ISSUE);

      // A truthful projection is published for the registered project.
      const projection = stores.controlStore.getProjection(PROJECT_ID);
      assert.equal(projection.payload.projectId, PROJECT_ID);
      assert.equal(projection.payload.controlMode, 'shadow');
      assert.equal(projection.payload.counts.ready >= 1, true);
    } finally {
      stores.close();
    }
  });
});

test('live-style collector output passes the accepted planner, curator and authority validators', async () => {
  await withProduction(async (context) => {
    const { adapters } = fakeAdapters();
    const stores = context.openStores();
    try {
      const resolvePorts = createProductionManagementPorts({
        adapters,
        controlStore: stores.controlStore,
        profileRegistry: context.profileRegistry,
        producerId: 'test-management-controller',
        now: () => T0,
      });
      const ports = await resolvePorts({
        role: 'programme',
        mode: 'shadow',
        event: { projectId: PROJECT_ID, repository: REPOSITORY },
        project: context.registry.projectsById[PROJECT_ID],
      });
      const collected = ports.collectEvidence();
      // Provenance, not shape: these objects were produced by the accepted
      // #261/#266 validators, which is what the role handlers demand.
      assert.equal(collected.queueEvidence.projectId, PROJECT_ID);
      assert.equal(collected.sourceSha, SOURCE_SHA);
      assert.equal(collected.queueEvidence.proposal.brief.evidence.profile.projectId, PROJECT_ID);
      assert.equal(collected.quotaAdmission.state, 'available');
      assert.equal(collected.implementationSlot.occupied, false);
      assert.deepEqual(collected.authorityLedger.issued, []);
      // A candidate request was derived for the live bound issue.
      assert.equal(collected.candidateRequests.length, 1);
      assert.equal(collected.candidateRequests[0].curationKey, CURATION_KEY);
      assert.equal(collected.candidateRequests[0].branch, `claude/shadow-equivalence-evidence-${READY_ISSUE}`);
      // Shadow wires no mutating port at all.
      assert.equal('applyQueueMutation' in ports, false);
      assert.equal('publishWorkerAuthority' in ports, false);
    } finally {
      stores.close();
    }
  });
});

test('the assurance collector is independent and structurally read-only', async () => {
  await withProduction(async (context) => {
    const { adapters } = fakeAdapters();
    const stores = context.openStores();
    try {
      const resolvePorts = createProductionManagementPorts({
        adapters, controlStore: stores.controlStore, profileRegistry: context.profileRegistry, now: () => T0,
      });
      const ports = await resolvePorts({
        role: 'assurance',
        mode: 'active',
        event: { projectId: PROJECT_ID, repository: REPOSITORY },
        project: context.registry.projectsById[PROJECT_ID],
      });
      // Even in active mode assurance is handed exactly one port.
      assert.deepEqual(Object.keys(ports), ['collectEvidence']);
      const observation = ports.collectEvidence();
      assert.equal(observation.projectId, PROJECT_ID);
      assert.equal(observation.registeredRepository, REPOSITORY);
      assert.deepEqual(observation.quotaPolicy.forbiddenSignalsObserved, []);
    } finally {
      stores.close();
    }
  });
});

test('active mode applies the bounded mutation and records the granted authority durably', async () => {
  await withProduction(async (context) => {
    context.setMode('active');
    const { adapters, calls } = activeAdapters();
    const summary = await run({ ...context, adapters });

    assert.equal(summary.mode, 'active');
    assert.equal(calls.authority.length, 1, 'exactly one worker authority is published');
    const stores = context.openStores();
    try {
      const ledger = stores.controlStore.listIssuedAuthorities({ projectId: PROJECT_ID });
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].issueNumber, READY_ISSUE);
      assert.equal(ledger[0].state, 'issued');
    } finally {
      stores.close();
    }
  });
});

test('a second active cycle does not grant a second authority for the same work', async () => {
  await withProduction(async (context) => {
    context.setMode('active');
    const { adapters, calls } = activeAdapters();
    await run({ ...context, adapters });
    await run({ ...context, adapters });
    assert.equal(calls.authority.length, 1, 'the persisted ledger makes the duplicate an idempotent no-op');
  });
});

test('an execution event with no live authority settles as a harmless no-op', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters } = fakeAdapters();
    const summary = await run({ ...context, adapters });
    const execution = summary.cycle.results.find((entry) => entry.role === 'execution');
    if (execution) {
      assert.equal(execution.outcome, 'no-op');
      assert.equal(execution.settled, true);
    }
  });
});

// ------------------------------------------------------------ producers and wake

test('a second cycle over unchanged live evidence enqueues nothing new', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters } = fakeAdapters();
    const first = await run({ ...context, adapters });
    const second = await run({ ...context, adapters });
    assert.ok(first.observations[0].enqueued > 0);
    assert.equal(second.observations[0].enqueued, 0, 'unchanged evidence must enqueue nothing');
    assert.ok(second.observations[0].suppressed > 0, 'and must be durably suppressed instead');
  });
});

test('changed live evidence produces a new wake on the next cycle', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters } = fakeAdapters();
    await run({ ...context, adapters });

    // The same issue becomes blocked: a genuine semantic change.
    const changed = fakeAdapters({
      listOpenIssues: () => [{
        number: READY_ISSUE,
        title: 'Record bounded shadow equivalence evidence for the management control plane',
        state: 'open',
        labels: ['status:blocked'],
        body: readyIssueBody(),
      }],
    });
    const second = await run({ ...context, adapters: changed.adapters });
    assert.ok(second.observations[0].enqueued + second.observations[0].coalesced > 0, 'changed evidence must wake the manager');
  });
});

test('an immediate wake fires once the event is durable, and a failing wake loses nothing', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters } = fakeAdapters();
    const attempts = [];
    const failingWake = {
      enabled: true,
      unit: 'agent-runner-event-polling.service',
      wake: () => { attempts.push('wake'); throw new Error('systemctl unavailable'); },
    };
    const summary = await run({ ...context, adapters, wake: failingWake });
    assert.ok(attempts.length > 0, 'a durable event must attempt an immediate wake');
    // The cycle still completed and the events were still processed.
    assert.equal(summary.ran, true);
    assert.ok(summary.cycle.processed > 0);
  });
});

test('a suppressed wake still leaves the event recoverable by the generic scan', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters } = fakeAdapters();
    // Observe only: nothing drains, and no wake is wired at all.
    const observed = await run({ ...context, adapters, overrides: { drain: false } });
    assert.ok(observed.observations[0].enqueued > 0);

    const stores = context.openStores();
    let pending;
    try {
      pending = stores.eventStore.listEvents({ states: ['pending'] }).length;
    } finally {
      stores.close();
    }
    assert.ok(pending > 0, 'the event stays durable when no wake was delivered');

    // A later generic cycle recovers and drains it without any new observation.
    const recovered = await run({ ...context, adapters, overrides: { observe: false } });
    assert.ok(recovered.recovery.dueCount > 0, 'generic recovery must find the lost-wake event');
    assert.ok(recovered.cycle.processed > 0, 'and the controller must then drain it');
  });
});

test('the systemd wake is off unless explicitly configured and only allowlisted units are accepted', () => {
  assert.equal(createSystemdManagementWake({ env: {} }).enabled, false);
  assert.equal(createSystemdManagementWake({ env: { [MANAGEMENT_WAKE_UNIT_ENV]: 'anything.service' } }).enabled, false);

  const started = [];
  const configured = createSystemdManagementWake({
    env: { [MANAGEMENT_WAKE_UNIT_ENV]: 'agent-runner-event-polling.service' },
    spawn: (command, args) => { started.push([command, ...args]); return { status: 0 }; },
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.wake().ok, true);
  assert.deepEqual(started[0], ['systemctl', '--user', 'start', '--no-block', 'agent-runner-event-polling.service']);

  // Every allowlisted unit is a generic, project- and role-neutral unit.
  for (const unit of ALLOWED_WAKE_UNITS) {
    assert.ok(!/programme|execution-manager|assurance|queue-oversight/i.test(unit), unit);
  }
});

test('a wake that throws is reported, never propagated', () => {
  const wake = createSystemdManagementWake({
    env: { [MANAGEMENT_WAKE_UNIT_ENV]: 'agent-runner-event-polling.service' },
    spawn: () => { throw new Error('no systemctl'); },
  });
  const result = wake.wake();
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
});

// ------------------------------------------------------------ observer seam

test('the observer reports only semantic change, never cosmetic churn', async () => {
  await withProduction(async (context) => {
    const stores = context.openStores();
    try {
      const profile = context.profileRegistry.projectsById[PROJECT_ID];
      const project = context.registry.projectsById[PROJECT_ID];
      const { adapters } = fakeAdapters();
      const before = observeMaterialTransitions({ project, profile, adapters, controlStore: stores.controlStore, expectedSourceSha: SOURCE_SHA });

      // A retitled, re-bodied issue with identical management-relevant state.
      const cosmetic = fakeAdapters({
        listOpenIssues: () => [{
          number: READY_ISSUE,
          title: 'A completely different title that changes nothing management reasons about',
          state: 'open',
          labels: ['status:ready'],
          body: `${readyIssueBody()}\n\nSome extra human prose.`,
        }],
      });
      const after = observeMaterialTransitions({
        project, profile, adapters: cosmetic.adapters, controlStore: stores.controlStore, expectedSourceSha: SOURCE_SHA,
      });
      const fingerprintsOf = (list) => list.map((entry) => `${entry.kind}:${entry.evidenceFingerprint}`).sort();
      assert.deepEqual(fingerprintsOf(after), fingerprintsOf(before), 'cosmetic change must not move any fingerprint');
    } finally {
      stores.close();
    }
  });
});

test('the observer only emits allowlisted, identity-only transitions', async () => {
  await withProduction(async (context) => {
    const stores = context.openStores();
    try {
      const { adapters } = fakeAdapters();
      const transitions = observeMaterialTransitions({
        project: context.registry.projectsById[PROJECT_ID],
        profile: context.profileRegistry.projectsById[PROJECT_ID],
        adapters,
        controlStore: stores.controlStore,
        expectedSourceSha: SOURCE_SHA,
      });
      assert.ok(transitions.length > 0);
      const allowed = new Set(['kind', 'projectId', 'repository', 'issueNumber', 'pullRequestNumber', 'sha', 'evidenceFingerprint']);
      for (const entry of transitions) {
        for (const key of Object.keys(entry)) {
          assert.ok(allowed.has(key), `${entry.kind} carried a non-identity field: ${key}`);
        }
      }
    } finally {
      stores.close();
    }
  });
});

test('the curated issue body reader recovers exactly the written curation identity', () => {
  const parsed = parseCuratedIssueBody(readyIssueBody());
  assert.equal(parsed.curationKey, CURATION_KEY);
  assert.deepEqual([...parsed.dependsOn], []);
  const withDependencies = parseCuratedIssueBody([
    `<!-- agent-runner:queue-curation-key: ${CURATION_KEY} -->`,
    '<!-- agent-runner:queue-dependencies:start -->',
    '- #12',
    '- #34',
    '<!-- agent-runner:queue-dependencies:end -->',
  ].join('\n'));
  assert.deepEqual([...withDependencies.dependsOn], [12, 34]);
  assert.equal(parseCuratedIssueBody('no markers here').curationKey, null);
});

// ------------------------------------------------------------ failure isolation

test('a collector failure stops that project without aborting the cycle', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters } = fakeAdapters({
      readSourceSha: () => { throw new Error('git unavailable'); },
    });
    const summary = await run({ ...context, adapters });
    assert.equal(summary.ran, true);
    assert.equal(summary.observations[0].observed, false);
    assert.equal(summary.observations[0].reason, 'observation-failed');
  });
});

test('quota ambiguity fails closed into a bounded delayed retry with no credit check', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters, calls } = fakeAdapters({
      readQuotaAdmission: ({ profileName }) => ({ state: 'ambiguous', profileName }),
    });
    await run({ ...context, adapters });
    const stores = context.openStores();
    try {
      const decision = stores.controlStore.listDecisions({ projectId: PROJECT_ID }).find((entry) => entry.role === 'programme');
      assert.equal(decision.outcome, 'delayed-retry');
      assert.equal(decision.reason, 'quota-ambiguous');
    } finally {
      stores.close();
    }
    assert.deepEqual(calls.authority, []);
  });
});

test('an occupied global implementation slot authorises nothing new', async () => {
  await withProduction(async (context) => {
    context.setMode('active');
    const { adapters, calls } = activeAdapters({ readImplementationSlot: () => ({ state: 'occupied', occupied: true }) });
    await run({ ...context, adapters });
    assert.deepEqual(calls.authority, [], 'the one global implementation slot is never widened');
  });
});
