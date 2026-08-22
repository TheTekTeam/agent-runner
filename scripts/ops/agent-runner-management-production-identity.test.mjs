import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runManagementCycleCommand } from './agent-runner-management-cycle-command.mjs';
import { openManagementStores } from './agent-runner-management-control-store.mjs';
import { produceManagementEvents } from './agent-runner-management-producers.mjs';
import { observeMaterialTransitions } from './agent-runner-management-observer.mjs';
import {
  MANAGEMENT_PLAN_REGISTRY,
  resolveRegisteredManagementPlan,
} from './agent-runner-management-plan-registry.mjs';
import { fakeWriteTransport } from './agent-runner-management-test-fixtures.mjs';
import { loadManagerProfileRegistry } from './agent-runner-manager-profile-registry.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';

/**
 * #268 production identity, merge/activation wakes, second-project acceptance
 * and producer concurrency. Every test drives the shipped entrypoint, observer
 * and producer; only the outermost adapter surface is faked.
 */

const PROJECT_ID = 'agent-runner';
const REPOSITORY = 'TheTekTeam/agent-runner';
const SOURCE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'd'.repeat(40);
const OTHER_HEAD_SHA = 'e'.repeat(40);
const MERGE_SHA = 'f'.repeat(40);
const DOC_SHA = 'b'.repeat(64);
const READY_ISSUE = 900;
const PULL_NUMBER = 42;
const BRANCH = 'claude/shadow-equivalence-evidence-900';
const CURATION_KEY = 'qc:agent-runner:shadow-equivalence-evidence';
const T0 = '2026-08-22T09:00:00.000Z';

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

function curatedBody(curationKey) {
  return [
    '<!-- agent-runner:queue-curation -->',
    `<!-- agent-runner:queue-curation-key: ${curationKey} -->`,
    '<!-- agent-runner:queue-dependencies:start -->',
    '## Depends on',
    '',
    '<!-- agent-runner:queue-dependencies:end -->',
  ].join('\n');
}

function readyIssues(curationKey = CURATION_KEY, number = READY_ISSUE, title = 'Record bounded shadow equivalence evidence for the management control plane') {
  return [{ number, title, state: 'open', labels: ['status:ready'], body: curatedBody(curationKey) }];
}

/** One attempt shaped exactly as the Dell adapter returns it. */
function attemptFor({ pullRequestNumber = PULL_NUMBER, headSha = HEAD_SHA, issueNumber = READY_ISSUE, review, ci, pullState = 'open' } = {}) {
  return {
    attemptId: `attempt-${BRANCH.replace(/[^A-Za-z0-9._:-]/g, '-')}`,
    issueNumber,
    evidenceRevision: `attempt-${headSha.slice(0, 16)}`,
    evidenceSequence: 1,
    evidenceTimestamp: '2026-08-22T09:00:00Z',
    publication: {
      attemptId: `attempt-${BRANCH.replace(/[^A-Za-z0-9._:-]/g, '-')}`,
      headSha,
      completionState: 'published',
      pullRequestNumber,
      changedFileCount: 2,
      changedPaths: [],
      insertions: 10,
      deletions: 1,
      validationChecks: [],
      summary: 'Implementation attempt published a pull request.',
    },
    pullRequest: {
      number: pullRequestNumber,
      branch: BRANCH,
      baseSha: SOURCE_SHA,
      headSha,
      state: pullState,
      draft: true,
      mergeableState: 'clean',
      changedFileCount: 2,
      changedPaths: [],
    },
    ci: ci ?? { headSha, checks: [{ name: 'npm test', state: 'success', required: true }] },
    review: review ?? { pullRequestNumber, headSha, state: 'no-blockers', findings: [] },
    ownership: { activeLeases: [], openPullRequests: [], workspace: null },
  };
}

function fakeAdapters(overrides = {}) {
  const calls = { authority: [], mutation: [], continuation: [], attemptReads: [] };
  const base = {
    readSourceSha: () => SOURCE_SHA,
    readInstructionDocument: () => ({ sha256: DOC_SHA, freshness: 'current' }),
    listOpenIssues: () => readyIssues(),
    listOpenPullRequests: () => [],
    readQuotaAdmission: ({ profileName }) => ({ state: 'available', profileName }),
    readImplementationSlot: () => ({ state: 'free', occupied: false }),
    readOwnership: () => ({ activeLeases: [], openPullRequests: [] }),
    readAttempt: () => null,
    readHosts: () => ({ controllerHost: 'dell', schedulerHost: 'dell', nonSchedulerHosts: [] }),
  };
  return { adapters: { ...base, ...overrides }, calls };
}

async function withProduction(fn, { projects = [[PROJECT_ID, REPOSITORY]] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-management-identity-'));
  try {
    const files = [];
    for (const [projectId, repo] of projects) {
      writeFileSync(join(dir, `${projectId}.json`), JSON.stringify(projectConfig(projectId, repo, join(dir, `checkout-${projectId}`))));
      files.push(`${projectId}.json`);
    }
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: files }));
    const registry = loadProjectRegistry({ registryPath });
    const profileRegistry = loadManagerProfileRegistry({
      entries: projects.map(([projectId]) => ({ projectId, configPath: `../../config/manager-profiles/${projectId}.json` })),
      projectRegistry: registry,
    });
    const dbPath = join(dir, 'controller.sqlite');
    const options = {
      help: false, registryPath, dbPath, scope: 'global', controllerId: 'test-management-controller',
      maxEvents: 20, expectedSourceSha: null, observe: true, drain: true,
    };
    const setMode = (mode) => {
      const stores = openManagementStores(dbPath, { registry, now: () => T0 });
      try {
        stores.controlStore.setControlMode({ mode, reason: 'identity acceptance', actor: 'test-operator', now: T0 });
      } finally {
        stores.close();
      }
    };
    const openStores = () => openManagementStores(dbPath, { registry, now: () => T0 });
    return await fn({ dir, registry, profileRegistry, options, dbPath, setMode, openStores });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run({ options, registry, profileRegistry, adapters, writeAdapters = null, overrides = {} }) {
  return runManagementCycleCommand({
    options: { ...options, ...overrides },
    registry,
    profileRegistry,
    adapters,
    // The real production write-transport *factory*; only the outermost GitHub
    // side effect is faked. The cycle invokes it only when the mode is active.
    createWriteAdapters: () => writeAdapters ?? fakeWriteTransport(),
    wake: null,
    now: () => T0,
    uuid: () => '00000000-0000-4000-8000-000000000001',
  });
}

// ------------------------------------------ 1 + 2: exact attempt identity

test('the full causal chain binds the exact issue, pull request and head end to end', async () => {
  await withProduction(async (context) => {
    context.setMode('active');

    // 1. An authority is issued for the ready issue.
    const writeTransport = fakeWriteTransport();
    const first = fakeAdapters();
    await run({ ...context, adapters: first.adapters, writeAdapters: writeTransport });
    assert.equal(writeTransport.calls.comments.length, 1, 'exactly one worker authority packet is published');

    // 2. The attempt publishes a pull request at an exact head.
    const published = fakeAdapters({
      listOpenPullRequests: () => [{ number: PULL_NUMBER, title: 'x', headSha: HEAD_SHA, branch: BRANCH, issueNumber: READY_ISSUE, labels: [] }],
      readOwnership: () => ({
        activeLeases: [],
        openPullRequests: [{ number: PULL_NUMBER, issueNumber: READY_ISSUE, headSha: HEAD_SHA }],
      }),
      readAttempt: ({ pullRequestNumber }) => {
        published.calls.attemptReads.push(pullRequestNumber);
        return attemptFor({ pullRequestNumber: pullRequestNumber ?? PULL_NUMBER });
      },
    });
    const second = await run({ ...context, adapters: published.adapters, writeAdapters: writeTransport });

    // 3. The execution collector read the exact pull request the event named.
    assert.ok(published.calls.attemptReads.includes(PULL_NUMBER), 'the exact PR number must reach readAttempt');

    // 4. Execution reconciled real evidence rather than settling a no-op.
    const execution = second.cycle.results.filter((entry) => entry.role === 'execution');
    assert.ok(execution.length > 0, 'an execution reconciliation must have run');
    assert.ok(
      execution.some((entry) => entry.outcome !== 'no-op'),
      `a real transition must not settle as a no-op: ${JSON.stringify(execution.map((e) => e.outcome))}`,
    );

    // 5. Green exact-head evidence settles to independent assurance, and the
    //    chain reaches programme reconciliation again.
    const roles = second.cycle.results.map((entry) => entry.role);
    assert.ok(roles.includes('programme'));
    assert.ok(roles.includes('execution'));

    const stores = context.openStores();
    try {
      const decision = stores.controlStore.listDecisions({ projectId: PROJECT_ID })
        .find((entry) => entry.role === 'execution' && entry.outcome !== 'no-op');
      assert.ok(decision, 'a real execution decision must be recorded');
      assert.equal(decision.issueNumber, READY_ISSUE);
      assert.equal(decision.pullRequestNumber, PULL_NUMBER);
      assert.equal(decision.sha, HEAD_SHA);
    } finally {
      stores.close();
    }
  });
});

test('an execution event that cannot name its issue is blocked, never resolved by guesswork', async () => {
  await withProduction(async (context) => {
    context.setMode('active');
    const writeTransport = fakeWriteTransport();
    const { adapters } = fakeAdapters();
    await run({ ...context, adapters, writeAdapters: writeTransport });

    const stores = context.openStores();
    try {
      // An execution wake with no issue identity, as an older build could have left.
      stores.eventStore.enqueue({
        eventType: 'execution-reconcile-required',
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        correlationId: 'ambiguous-wake',
      });
    } finally {
      stores.close();
    }

    const summary = await run({ ...context, adapters, writeAdapters: writeTransport, overrides: { observe: false } });
    const execution = summary.cycle.results.find((entry) => entry.role === 'execution');
    assert.equal(execution.outcome, 'blocked');
    assert.equal(execution.reason, 'ambiguous-attempt-identity');
  });
});

test('with several historical authorities an event reconciles only its own attempt', async () => {
  await withProduction(async (context) => {
    context.setMode('active');
    const writeTransport = fakeWriteTransport();
    const { adapters } = fakeAdapters();
    await run({ ...context, adapters, writeAdapters: writeTransport });

    const stores = context.openStores();
    try {
      // A historical authority for a different issue, recorded earlier.
      stores.controlStore.recordIssuedAuthority({
        authorityKey: 'mwa:historical-authority-key',
        authorityFingerprint: `sha256:${'9'.repeat(64)}`,
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        issueNumber: 111,
        branch: 'claude/historical-111',
        baseSha: SOURCE_SHA,
        state: 'issued',
        now: T0,
      });
      const ledger = stores.controlStore.listIssuedAuthorities({ projectId: PROJECT_ID });
      assert.equal(ledger.length, 2, 'two authorities now exist');

      // The event for the historical issue must not resolve the live one.
      stores.eventStore.enqueue({
        eventType: 'execution-reconcile-required',
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        issueNumber: 111,
        correlationId: 'historical-wake',
      });
    } finally {
      stores.close();
    }

    const reads = [];
    const bound = fakeAdapters({
      readAttempt: ({ pullRequestNumber }) => { reads.push(pullRequestNumber); return null; },
    });
    const summary = await run({ ...context, adapters: bound.adapters, writeAdapters: writeTransport, overrides: { observe: false } });
    const execution = summary.cycle.results.find((entry) => entry.role === 'execution');
    // Issue 111's authority cannot be reproduced from current evidence, so the
    // event fails closed instead of reconciling issue 900's attempt.
    assert.ok(['blocked', 'no-op', 'handler-failed'].includes(execution.outcome));
    assert.notEqual(execution.outcome, 'assurance-required');
  });
});

test('an attempt read that returns a different pull request is refused', async () => {
  await withProduction(async (context) => {
    context.setMode('active');
    const first = fakeAdapters();
    const writeTransport = fakeWriteTransport();
    await run({ ...context, adapters: first.adapters, writeAdapters: writeTransport });

    const wrongPull = fakeAdapters({
      listOpenPullRequests: () => [{ number: PULL_NUMBER, title: 'x', headSha: HEAD_SHA, branch: BRANCH, issueNumber: READY_ISSUE, labels: [] }],
      readOwnership: () => ({
        activeLeases: [],
        openPullRequests: [{ number: PULL_NUMBER, issueNumber: READY_ISSUE, headSha: HEAD_SHA }],
      }),
      // Returns a *different* pull request than the one asked for.
      readAttempt: () => attemptFor({ pullRequestNumber: 999 }),
    });
    const summary = await run({ ...context, adapters: wrongPull.adapters, writeAdapters: writeTransport });
    const execution = summary.cycle.results.find((entry) => entry.role === 'execution' && entry.reason === 'attempt-identity-mismatch');
    assert.ok(execution, 'a substituted pull request must be refused');
    assert.equal(execution.outcome, 'blocked');
  });
});

test('an attempt read at a head other than the event head is refused', async () => {
  await withProduction(async (context) => {
    context.setMode('active');
    const first = fakeAdapters();
    const writeTransport = fakeWriteTransport();
    await run({ ...context, adapters: first.adapters, writeAdapters: writeTransport });

    const stale = fakeAdapters({
      listOpenPullRequests: () => [{ number: PULL_NUMBER, title: 'x', headSha: HEAD_SHA, branch: BRANCH, issueNumber: READY_ISSUE, labels: [] }],
      readOwnership: () => ({
        activeLeases: [],
        openPullRequests: [{ number: PULL_NUMBER, issueNumber: READY_ISSUE, headSha: HEAD_SHA }],
      }),
      // Evidence read at an older head than the one the event names.
      readAttempt: () => attemptFor({ headSha: OTHER_HEAD_SHA }),
    });
    const summary = await run({ ...context, adapters: stale.adapters, writeAdapters: writeTransport });
    const execution = summary.cycle.results.find((entry) => entry.role === 'execution' && entry.reason === 'attempt-identity-mismatch');
    assert.ok(execution, 'a head mismatch must be refused');
  });
});

// ------------------------------------------ 3: fail-closed slot

test('an ambiguous implementation slot blocks new authority and retries later', async () => {
  await withProduction(async (context) => {
    context.setMode('active');
    const writeTransport = fakeWriteTransport();
    const { adapters } = fakeAdapters({
      readImplementationSlot: () => ({ state: 'ambiguous', occupied: false, reason: 'lock-unreadable' }),
    });
    await run({ ...context, adapters, writeAdapters: writeTransport });
    assert.deepEqual(writeTransport.calls.comments, [], 'an unprovable slot must never admit a new authority');

    const stores = context.openStores();
    try {
      const decision = stores.controlStore.listDecisions({ projectId: PROJECT_ID }).find((entry) => entry.role === 'programme');
      assert.equal(decision.outcome, 'delayed-retry');
      assert.equal(decision.reason, 'implementation-slot-ambiguous');
    } finally {
      stores.close();
    }
  });
});

test('an active worker holds its issue before any pull request exists', async () => {
  await withProduction(async (context) => {
    context.setMode('active');
    const writeTransport = fakeWriteTransport();
    const first = fakeAdapters();
    await run({ ...context, adapters: first.adapters, writeAdapters: writeTransport });
    assert.equal(writeTransport.calls.comments.length, 1);

    // Second cycle: still no pull request, but the ledger proves the lease.
    const second = fakeAdapters();
    await run({ ...context, adapters: second.adapters, writeAdapters: writeTransport });
    assert.equal(writeTransport.calls.comments.length, 1, 'the held issue is never handed to a second attempt');
  });
});

// ------------------------------------------ 5: merge and source activation

test('accepted merge evidence wakes programme reconciliation after the pull request closes', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const { adapters } = fakeAdapters({
      // The pull request has left the open list and merged.
      listOpenPullRequests: () => [],
      listRecentlyClosedPullRequests: () => [
        { number: PULL_NUMBER, headSha: HEAD_SHA, branch: BRANCH, issueNumber: READY_ISSUE, merged: true, mergeCommitSha: MERGE_SHA },
      ],
    });
    const stores = context.openStores();
    try {
      const transitions = observeMaterialTransitions({
        project: context.registry.projectsById[PROJECT_ID],
        profile: context.profileRegistry.projectsById[PROJECT_ID],
        adapters,
        controlStore: stores.controlStore,
      });
      const merge = transitions.find((entry) => entry.kind === 'merge-evidence-accepted');
      assert.ok(merge, 'a merged pull request must be observed after it closes');
      assert.equal(merge.issueNumber, READY_ISSUE);
      assert.equal(merge.pullRequestNumber, PULL_NUMBER);
      assert.equal(merge.sha, MERGE_SHA);

      const produced = produceManagementEvents({
        eventStore: stores.eventStore, controlStore: stores.controlStore, transitions: [merge], now: T0,
      });
      assert.equal(produced.produced[0].eventType, 'programme-reconcile-required');
    } finally {
      stores.close();
    }
  });
});

test('a closed pull request that never merged is not inferred to have merged', async () => {
  await withProduction(async (context) => {
    const { adapters } = fakeAdapters({
      listOpenPullRequests: () => [],
      listRecentlyClosedPullRequests: () => [
        { number: PULL_NUMBER, headSha: HEAD_SHA, branch: BRANCH, issueNumber: READY_ISSUE, merged: false, mergeCommitSha: null },
      ],
    });
    const stores = context.openStores();
    try {
      const transitions = observeMaterialTransitions({
        project: context.registry.projectsById[PROJECT_ID],
        profile: context.profileRegistry.projectsById[PROJECT_ID],
        adapters,
        controlStore: stores.controlStore,
      });
      assert.equal(transitions.some((entry) => entry.kind === 'merge-evidence-accepted'), false);
    } finally {
      stores.close();
    }
  });
});

test('source activation wakes programme reconciliation with no operator-supplied SHA', async () => {
  await withProduction(async (context) => {
    for (const [result, applied] of [['activated', true], ['refused', false]]) {
      const { adapters } = fakeAdapters({
        readSourceActivationEvidence: () => ({
          result, requestedTarget: SOURCE_SHA, finalHead: applied ? SOURCE_SHA : null, recordedAt: T0,
        }),
      });
      const stores = context.openStores();
      try {
        const transitions = observeMaterialTransitions({
          project: context.registry.projectsById[PROJECT_ID],
          profile: context.profileRegistry.projectsById[PROJECT_ID],
          adapters,
          controlStore: stores.controlStore,
          // Deliberately no expectedSourceSha: the durable record is enough.
        });
        const activation = transitions.find((entry) => entry.kind === 'source-activation-settled');
        assert.ok(activation, `activation result '${result}' must be observed`);
        const produced = produceManagementEvents({
          eventStore: stores.eventStore, controlStore: stores.controlStore, transitions: [activation], now: T0,
        });
        assert.equal(produced.produced[0].eventType, 'programme-reconcile-required');
      } finally {
        stores.close();
      }
    }
  });
});

test('applied and refused activation are distinguishable and each wakes once', async () => {
  await withProduction(async (context) => {
    const stores = context.openStores();
    try {
      const observe = (result) => observeMaterialTransitions({
        project: context.registry.projectsById[PROJECT_ID],
        profile: context.profileRegistry.projectsById[PROJECT_ID],
        adapters: fakeAdapters({
          readSourceActivationEvidence: () => ({ result, requestedTarget: SOURCE_SHA, finalHead: SOURCE_SHA, recordedAt: T0 }),
        }).adapters,
        controlStore: stores.controlStore,
      }).find((entry) => entry.kind === 'source-activation-settled');

      const activated = observe('activated');
      const refused = observe('refused');
      assert.notEqual(activated.evidenceFingerprint, refused.evidenceFingerprint, 'applied and refused are different evidence');
    } finally {
      stores.close();
    }
  });
});

// ------------------------------------------ 6: producer concurrency

test('the semantic fingerprint is compared inside the write transaction', async () => {
  await withProduction(async (context) => {
    const stores = context.openStores();
    try {
      let insideTransaction = null;
      const realRead = stores.controlStore.getProducerState.bind(stores.controlStore);
      stores.controlStore.getProducerState = (key) => {
        insideTransaction = stores.eventStore.transactionActive;
        return realRead(key);
      };
      produceManagementEvents({
        eventStore: stores.eventStore,
        controlStore: stores.controlStore,
        transitions: [{
          kind: 'github-evidence-settled',
          projectId: PROJECT_ID,
          repository: REPOSITORY,
          evidenceFingerprint: `sha256:${'1'.repeat(64)}`,
        }],
        now: T0,
      });
      assert.equal(insideTransaction, true, 'the check must happen under BEGIN IMMEDIATE, not before it');
    } finally {
      stores.close();
    }
  });
});

test('two overlapping producers observing the same new evidence create exactly one event', async () => {
  await withProduction(async (context) => {
    // Two independent store pairs on separate connections, as two processes would be.
    const a = context.openStores();
    const b = context.openStores();
    try {
      const transition = {
        kind: 'github-evidence-settled',
        projectId: PROJECT_ID,
        repository: REPOSITORY,
        evidenceFingerprint: `sha256:${'2'.repeat(64)}`,
      };

      // Interleave precisely at the old time-of-check window: A has decided to
      // produce, and B commits its identical observation before A's own
      // transaction reads the persisted fingerprint.
      const realRun = a.eventStore.runInTransaction.bind(a.eventStore);
      let interleaved = false;
      a.eventStore.runInTransaction = (work) => {
        if (!interleaved) {
          interleaved = true;
          produceManagementEvents({
            eventStore: b.eventStore, controlStore: b.controlStore, transitions: [transition], now: T0,
          });
        }
        return realRun(work);
      };

      const resultA = produceManagementEvents({
        eventStore: a.eventStore, controlStore: a.controlStore, transitions: [transition], now: T0,
      });

      // A re-read inside its transaction, saw B's committed fingerprint and
      // suppressed. Exactly one semantic event exists.
      assert.equal(interleaved, true);
      assert.equal(resultA.suppressedCount, 1);
      assert.equal(resultA.insertedCount, 0);
      assert.equal(a.eventStore.listEvents({}).length, 1);
    } finally {
      a.close();
      b.close();
    }
  });
});

test('concurrency safety preserves restart suppression and correlation independence', async () => {
  await withProduction(async (context) => {
    const transition = (correlationId, fingerprint) => ({
      kind: 'github-evidence-settled',
      projectId: PROJECT_ID,
      repository: REPOSITORY,
      correlationId,
      evidenceFingerprint: fingerprint,
    });
    const first = context.openStores();
    try {
      produceManagementEvents({
        eventStore: first.eventStore, controlStore: first.controlStore,
        transitions: [transition('caller-one', `sha256:${'3'.repeat(64)}`)], now: T0,
      });
    } finally {
      first.close();
    }
    const reopened = context.openStores();
    try {
      // Different caller correlation, same semantic evidence, new connection.
      const replay = produceManagementEvents({
        eventStore: reopened.eventStore, controlStore: reopened.controlStore,
        transitions: [transition('caller-two', `sha256:${'3'.repeat(64)}`)], now: T0,
      });
      assert.equal(replay.suppressedCount, 1);
      // Genuinely changed evidence still produces exactly one new event.
      const changed = produceManagementEvents({
        eventStore: reopened.eventStore, controlStore: reopened.controlStore,
        transitions: [transition('caller-two', `sha256:${'4'.repeat(64)}`)], now: T0,
      });
      assert.equal(changed.suppressedCount, 0);
      assert.equal(changed.produced.length, 1);
    } finally {
      reopened.close();
    }
  });
});

// ------------------------------------------ registered plans and second project

test('every registered management plan validates against its registered profile', () => {
  const profiles = loadManagerProfileRegistry();
  assert.ok(MANAGEMENT_PLAN_REGISTRY.length >= 2, 'a second registered project is required for acceptance');
  const registered = MANAGEMENT_PLAN_REGISTRY.map((entry) => entry.projectId);
  assert.ok(registered.includes('agent-runner'));
  assert.ok(registered.includes('modelspend'));
  for (const entry of MANAGEMENT_PLAN_REGISTRY) {
    const profile = profiles.projectsById[entry.projectId];
    assert.ok(profile, `${entry.projectId} must have a registered manager profile`);
    const plan = resolveRegisteredManagementPlan({ projectId: entry.projectId, profile });
    assert.ok(plan, `${entry.projectId} must resolve a plan`);
    assert.equal(plan.projectId, entry.projectId);
    assert.ok(plan.proposedIssues.length > 0);
    // The plan's execution selection must be admissible under its own profile.
    assert.ok(profile.capabilities.allowlist.includes(plan.execution.adapter));
    assert.equal(plan.execution.capabilityProfile, profile.validation.profile);
  }
});

test('a shadow cycle processes both registered projects', async () => {
  await withProduction(async (context) => {
    context.setMode('shadow');
    const writeTransport = fakeWriteTransport();
    const { adapters } = fakeAdapters({
      listOpenIssues: ({ profile }) => (profile.projectId === PROJECT_ID
        ? readyIssues()
        : readyIssues('qc:modelspend:shadow-equivalence-evidence', 700, 'Record bounded ModelSpend shadow equivalence evidence')),
    });
    const summary = await run({ ...context, adapters, writeAdapters: writeTransport });

    assert.equal(summary.observations.length, 2, 'both registered projects are observed');
    for (const observation of summary.observations) {
      assert.equal(observation.observed, true, `${observation.projectId}: ${observation.reason ?? ''}`);
      assert.ok(observation.transitions > 0);
    }
    // Both produced a truthful projection, and neither mutated anything.
    const stores = context.openStores();
    try {
      const projected = stores.controlStore.listProjections({ limit: 10 }).map((entry) => entry.projectId).sort();
      assert.deepEqual(projected, ['agent-runner', 'modelspend']);
    } finally {
      stores.close();
    }
    assert.deepEqual(writeTransport.calls.createIssue, []);
    assert.deepEqual(writeTransport.calls.comments, []);
  }, { projects: [[PROJECT_ID, REPOSITORY], ['modelspend', 'TheTekTeam/modelspend']] });
});
