import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runManagementCycleCommand } from './agent-runner-management-cycle-command.mjs';
import { createDellManagementAdapters } from './agent-runner-management-dell-adapters.mjs';
import { createDellManagementWriteAdapters } from './agent-runner-management-write-adapters.mjs';
import { createProductionManagementPorts } from './agent-runner-management-collectors.mjs';
import { openManagementStores } from './agent-runner-management-control-store.mjs';
import {
  MANAGER_PREFLIGHT_MARKER,
  resolveCurrentManagerAuthority,
} from './agent-runner-manager-authority.mjs';
import { resolveDispatchAuthority } from './agent-runner-dispatch-authority.mjs';
import { loadManagerProfileRegistry } from './agent-runner-manager-profile-registry.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';

/**
 * #268 real active-mode production composition.
 *
 * Every test here builds adapters through the **same factories `main()` uses**
 * -- `createDellManagementAdapters()` and `createDellManagementWriteAdapters()`
 * -- and fakes only the outermost process transport. Injecting fake mutation
 * methods into the port layer would prove nothing about the composition that
 * actually runs on Dell, so it is deliberately not done.
 */

const PROJECT_ID = 'agent-runner';
const REPOSITORY = 'TheTekTeam/agent-runner';
const SOURCE_SHA = 'a'.repeat(40);
const READY_ISSUE = 900;
const CURATION_KEY = 'qc:agent-runner:shadow-equivalence-evidence';
const T0 = '2026-08-22T09:00:00.000Z';

function curatedBody() {
  return [
    '<!-- agent-runner:queue-curation -->',
    `<!-- agent-runner:queue-curation-key: ${CURATION_KEY} -->`,
    '## Scope',
    '',
    'Human-authored prose that must survive a dependency rewrite.',
    '',
    '<!-- agent-runner:queue-dependencies:start -->',
    '## Depends on',
    '',
    '<!-- agent-runner:queue-dependencies:end -->',
  ].join('\n');
}

/**
 * A bounded in-memory GitHub and process emulator behind `spawn`.
 *
 * This is the only faked layer: the real Dell read and write adapters run
 * against it exactly as they would against `gh` and `git`.
 */
function fakeProcess({ issues, comments = new Map(), calls } = {}) {
  return (command, args) => {
    const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });

    if (command === 'git') {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${SOURCE_SHA}\n`, stderr: '' };
      if (args[0] === 'show') return { status: 0, stdout: 'instruction document contents\n', stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected git command' };
    }
    // The accepted quota preflight entrypoint.
    if (command.endsWith('node') || command === process.execPath) {
      return json({ status: 'available', state: { quotaUsage: { session: { usedPercent: 5 } } } });
    }
    if (command !== 'gh') return { status: 1, stdout: '', stderr: 'unexpected command' };
    if (args[0] === 'api' && args[1] === 'graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }

    const method = args[2];
    const endpoint = args[3];
    calls.push(`${method} ${endpoint}`);

    if (method === 'GET' && endpoint === `/repos/${REPOSITORY}/issues`) {
      return json([...issues.values()]);
    }
    if (method === 'GET' && endpoint === `/repos/${REPOSITORY}/pulls`) return json([]);
    const issueMatch = /^\/repos\/.+\/issues\/(\d+)$/.exec(endpoint);
    const commentsMatch = /^\/repos\/.+\/issues\/(\d+)\/comments/.exec(endpoint);

    if (commentsMatch) {
      const number = Number(commentsMatch[1]);
      if (method === 'GET') return json(comments.get(number) ?? []);
      if (method === 'POST') {
        const body = JSON.parse(args[args.indexOf('--input') >= 0 ? -1 : -1] ?? 'null');
        return json({ id: 1, body });
      }
    }
    if (issueMatch) {
      const number = Number(issueMatch[1]);
      if (method === 'GET') return json(issues.get(number) ?? null);
      if (method === 'PATCH') return json({ number });
    }
    if (method === 'POST' && endpoint === `/repos/${REPOSITORY}/issues`) {
      return json({ number: 951 });
    }
    return json(null);
  };
}

/**
 * `gh api ... --input -` sends its payload on stdin, so the emulator needs the
 * spawn options to see what was written. This wrapper records both.
 */
function recordingProcess({ issues, comments, calls, writes }) {
  const base = fakeProcess({ issues, comments, calls });
  return (command, args, options = {}) => {
    if (command === 'gh' && args[0] === 'api' && typeof options.input === 'string') {
      const payload = JSON.parse(options.input);
      writes.push({ method: args[2], endpoint: args[3], payload });
      const commentsMatch = /^\/repos\/.+\/issues\/(\d+)\/comments/.exec(args[3]);
      if (commentsMatch && args[2] === 'POST') {
        const number = Number(commentsMatch[1]);
        const stored = comments.get(number) ?? [];
        stored.push({ id: stored.length + 1, body: payload.body, created_at: T0, user: { login: 'build-manager' } });
        comments.set(number, stored);
        return { status: 0, stdout: JSON.stringify({ id: stored.length }), stderr: '' };
      }
      const issueMatch = /^\/repos\/.+\/issues\/(\d+)$/.exec(args[3]);
      if (issueMatch && args[2] === 'PATCH') {
        const number = Number(issueMatch[1]);
        const issue = issues.get(number);
        if (issue) issues.set(number, { ...issue, ...payload });
        return { status: 0, stdout: JSON.stringify({ number }), stderr: '' };
      }
      if (args[2] === 'POST' && args[3] === `/repos/${REPOSITORY}/issues`) {
        issues.set(951, { number: 951, title: payload.title, body: payload.body, state: 'open', labels: [] });
        return { status: 0, stdout: JSON.stringify({ number: 951 }), stderr: '' };
      }
    }
    return base(command, args, options);
  };
}

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

async function withRealComposition(fn, { mode = 'active' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-active-production-'));
  try {
    writeFileSync(join(dir, 'agent-runner.json'), JSON.stringify(projectConfig(join(dir, 'checkout'))));
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: ['agent-runner.json'] }));
    const registry = loadProjectRegistry({ registryPath });
    const profileRegistry = loadManagerProfileRegistry({
      entries: [{ projectId: PROJECT_ID, configPath: '../../config/manager-profiles/agent-runner.json' }],
      projectRegistry: registry,
    });
    const dbPath = join(dir, 'controller.sqlite');

    const stores = openManagementStores(dbPath, { registry, now: () => T0 });
    try {
      stores.controlStore.setControlMode({ mode, reason: 'active production acceptance', actor: 'test-operator', now: T0 });
    } finally {
      stores.close();
    }

    const issues = new Map([[READY_ISSUE, {
      number: READY_ISSUE,
      title: 'Record bounded shadow equivalence evidence for the management control plane',
      state: 'open',
      // Deliberately unlabelled, so the deterministic #266 curation has a real
      // bounded label mutation to apply through the production transport.
      labels: [],
      body: curatedBody(),
    }]]);
    const comments = new Map();
    const calls = [];
    const writes = [];
    const spawn = recordingProcess({ issues, comments, calls, writes });

    // The env a Dell deployment supplies. The lock path is deliberately absent,
    // which is the one unambiguous "slot free".
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      AGENT_RUNNER_IMPLEMENTATION_LOCK: join(dir, 'absent.lock'),
      AGENT_RUNNER_SOURCE_ACTIVATION_EVIDENCE_DIR: join(dir, 'activation'),
    };

    // The exact factories main() composes.
    const adapters = createDellManagementAdapters({ spawn, env, now: () => T0 });
    const writeAdapters = createDellManagementWriteAdapters({ spawn, env });

    const options = {
      help: false, registryPath, dbPath, scope: 'global', controllerId: 'test-management-controller',
      maxEvents: 20, expectedSourceSha: null, observe: true, drain: true,
    };
    const run = (overrides = {}) => runManagementCycleCommand({
      options: { ...options, ...overrides.options },
      registry,
      profileRegistry,
      adapters,
      writeAdapters: 'writeAdapters' in overrides ? overrides.writeAdapters : writeAdapters,
      wake: null,
      now: () => T0,
      uuid: () => '00000000-0000-4000-8000-000000000001',
    });
    const openStores = () => openManagementStores(dbPath, { registry, now: () => T0 });
    return await fn({
      dir, registry, profileRegistry, options, dbPath, run, openStores,
      issues, comments, calls, writes, adapters, writeAdapters, env, spawn,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function publishedPackets(comments) {
  return [...comments.values()].flat().filter((comment) => String(comment.body).includes(MANAGER_PREFLIGHT_MARKER));
}

// ------------------------------------------------------------ active production

test('the real production composition performs the bounded queue mutation and publishes the canonical authority', async () => {
  await withRealComposition(async ({ run, comments, writes, issues }) => {
    const summary = await run();

    assert.equal(summary.ran, true);
    assert.equal(summary.mode, 'active');
    assert.equal(summary.writeTransportEnabled, true);

    // #266 bounded mutation reached GitHub through the real write adapter.
    const created = writes.filter((write) => write.method === 'POST' && write.endpoint.endsWith('/issues'));
    const patched = writes.filter((write) => write.method === 'PATCH');
    assert.ok(created.length + patched.length > 0, 'the validated queue mutation must reach GitHub');
    // Only the registered repository is ever touched.
    for (const write of writes) assert.ok(write.endpoint.startsWith(`/repos/${REPOSITORY}/issues`), write.endpoint);

    // #267 exact authority published as the canonical manager-preflight packet.
    const packets = publishedPackets(comments);
    assert.equal(packets.length, 1, 'exactly one authority packet is published');

    // The existing consumer path resolves it unchanged and treats it as the
    // current, claimable manager authority.
    const resolved = resolveCurrentManagerAuthority(packets);
    assert.equal(resolved.allowed, true, resolved.reason ?? '');
    assert.equal(resolved.authority.producerType, 'build_manager_authority_transition');
    assert.equal(resolved.authority.approvedAgent, 'claude-code-cli');
    assert.match(resolved.authority.authorityKey, /^manager-preflight:mwa:[a-f0-9]{32}:sha256:[a-f0-9]{64}$/);
    // It is the authority this control plane recorded, not some other packet.
    assert.ok(packets[0].body.includes(`issue: ${READY_ISSUE}`));
    assert.ok(issues.size >= 1);
  });
});

test('the published packet satisfies the accepted dispatch-authority contract', async () => {
  await withRealComposition(async ({ run, comments }) => {
    await run();
    const packets = publishedPackets(comments);
    const dispatch = resolveDispatchAuthority({
      comments: packets,
      repository: REPOSITORY,
      issueNumber: READY_ISSUE,
      agentId: 'claude-code-cli',
    });
    // The worker domain can consume what the manager produced; the manager
    // itself never claims or dispatches it.
    assert.notEqual(dispatch.reason, 'repository-scope-missing');
    assert.notEqual(dispatch.reason, 'manager-preflight-required');
  });
});

test('publication is durably recorded and a second active cycle publishes nothing further', async () => {
  await withRealComposition(async ({ run, comments, openStores }) => {
    await run();
    await run();
    assert.equal(publishedPackets(comments).length, 1, 'no duplicate authority packet');

    const stores = openStores();
    try {
      const publications = stores.controlStore.listPublications({ projectId: PROJECT_ID });
      assert.equal(publications.length, 1);
      assert.equal(publications[0].state, 'confirmed');
      assert.equal(publications[0].kind, 'worker-authority');
      // The issuance inputs are pinned, so the authority stays reproducible.
      assert.ok(stores.controlStore.getAuthorityIssuance(publications[0].authorityKey));
      assert.equal(stores.controlStore.listIssuedAuthorities({ projectId: PROJECT_ID }).length, 1);
    } finally {
      stores.close();
    }
  });
});

test('an interrupted publication resumes on the next real production cycle', async () => {
  await withRealComposition(async ({ run, comments, openStores, dir, registry }) => {
    // A write transport whose comment POST always fails before any side effect.
    const broken = {
      createQueueMutationClient: () => ({
        createIssue: () => ({ number: 951 }),
        updateIssueLabels: () => ({ ok: true }),
        updateIssueDependencies: () => ({ ok: true }),
      }),
      listIssueComments: () => [],
      createIssueComment: () => { throw new Error('comment transport failed'); },
    };
    await run({ writeAdapters: broken });
    assert.equal(publishedPackets(comments).length, 0, 'nothing was published');

    const stores = openStores();
    try {
      const pending = stores.controlStore.listPendingPublications({ projectId: PROJECT_ID });
      assert.equal(pending.length, 1, 'the publication is still owed');
    } finally {
      stores.close();
    }
    assert.ok(dir && registry);

    // The next cycle, with a healthy transport, resumes and publishes once.
    await run();
    assert.equal(publishedPackets(comments).length, 1);
    const healed = openStores();
    try {
      assert.equal(healed.controlStore.listPendingPublications({ projectId: PROJECT_ID }).length, 0);
    } finally {
      healed.close();
    }
  });
});

test('active mode without a write transport refuses to run rather than half-managing', async () => {
  await withRealComposition(async ({ run, comments }) => {
    const summary = await run({ writeAdapters: null });
    assert.equal(summary.ran, false);
    assert.equal(summary.refusal, 'write-transport-unavailable');
    assert.equal(publishedPackets(comments).length, 0);
  });
});

// ------------------------------------------------------------ shadow / fenced / disabled

test('shadow mode performs zero GitHub writes and publishes nothing', async () => {
  await withRealComposition(async ({ run, writes, comments }) => {
    const summary = await run();
    assert.equal(summary.mode, 'shadow');
    assert.equal(summary.writeTransportEnabled, false, 'no write transport is even constructed in shadow');
    assert.deepEqual(writes, [], 'zero GitHub writes');
    assert.equal(publishedPackets(comments).length, 0);
    // The decision was still computed, which is the point of shadow.
    assert.ok(summary.cycle.processed > 0);
  }, { mode: 'shadow' });
});

test('fenced and disabled modes perform zero writes and claim nothing', async () => {
  for (const mode of ['fenced', 'disabled']) {
    // eslint-disable-next-line no-await-in-loop -- each mode needs its own state
    await withRealComposition(async ({ run, writes, comments }) => {
      const summary = await run();
      assert.equal(summary.ran, false, mode);
      assert.equal(summary.refusal, `mode-${mode}`);
      assert.deepEqual(writes, []);
      assert.equal(publishedPackets(comments).length, 0);
    }, { mode });
  }
});

test('assurance receives only collectEvidence, in active mode, from the real factory', async () => {
  await withRealComposition(async ({ adapters, writeAdapters, registry, profileRegistry, openStores }) => {
    const stores = openStores();
    try {
      const resolvePorts = createProductionManagementPorts({
        adapters, writeAdapters, controlStore: stores.controlStore, profileRegistry, now: () => T0,
      });
      const ports = await resolvePorts({
        role: 'assurance',
        mode: 'active',
        event: { projectId: PROJECT_ID, repository: REPOSITORY },
        project: registry.projectsById[PROJECT_ID],
      });
      // Structurally: one port, and none of the write surfaces.
      assert.deepEqual(Object.keys(ports), ['collectEvidence']);
      for (const name of ['applyQueueMutation', 'publishWorkerAuthority', 'publishContinuationAuthority']) {
        assert.equal(name in ports, false, name);
      }
    } finally {
      stores.close();
    }
  });
});

test('the production read adapter exposes no write surface at all', async () => {
  await withRealComposition(async ({ adapters }) => {
    for (const name of ['applyQueueMutationClient', 'publishWorkerAuthority', 'publishContinuationAuthority', 'createIssueComment', 'createQueueMutationClient']) {
      assert.equal(typeof adapters[name], 'undefined', `the read adapter must not expose ${name}`);
    }
  });
});

// ------------------------------------------------------------ write-adapter bounds

test('the write adapter refuses an endpoint outside the declared repository', async () => {
  await withRealComposition(async ({ writeAdapters }) => {
    const client = writeAdapters.createQueueMutationClient({ repository: REPOSITORY });
    assert.throws(
      () => client.updateIssueLabels({ endpoint: '/repos/Other/repo/issues/1', labels: [] }),
      /does not target the declared repository/,
    );
    assert.throws(
      () => client.createIssue({ endpoint: '/repos/Other/repo/issues', title: 't', body: 'b', labels: [] }),
      /does not target the declared repository/,
    );
    // A malformed repository is refused outright rather than reaching GitHub.
    assert.throws(
      () => writeAdapters.createIssueComment({ repository: 'not-a-repository', issueNumber: 1, body: 'x' }),
      /bounded "owner\/name" repository is required/,
    );
    assert.throws(
      () => client.updateIssueLabels({ endpoint: '/repos/TheTekTeam/agent-runner/pulls/1', labels: [] }),
      /not allowlisted/,
    );
  });
});

test('a dependency update replaces only the managed block and preserves human prose', async () => {
  await withRealComposition(async ({ writeAdapters, issues, writes }) => {
    const client = writeAdapters.createQueueMutationClient({ repository: REPOSITORY });
    client.updateIssueDependencies({
      endpoint: `/repos/${REPOSITORY}/issues/${READY_ISSUE}`,
      issueNumber: READY_ISSUE,
      dependencyBlock: [
        '<!-- agent-runner:queue-dependencies:start -->',
        '## Depends on',
        '',
        '- #12',
        '<!-- agent-runner:queue-dependencies:end -->',
      ].join('\n'),
    });
    const patch = writes.find((write) => write.method === 'PATCH' && write.payload.body);
    assert.ok(patch, 'the body must be patched');
    assert.ok(patch.payload.body.includes('Human-authored prose that must survive a dependency rewrite.'));
    assert.ok(patch.payload.body.includes('- #12'));
    assert.ok(patch.payload.body.includes(CURATION_KEY), 'the curation identity is preserved');
    assert.ok(issues.size >= 1);
  });
});

test('a dependency update fails closed when the managed markers are ambiguous', async () => {
  await withRealComposition(async ({ writeAdapters, issues }) => {
    issues.set(READY_ISSUE, {
      ...issues.get(READY_ISSUE),
      body: `${curatedBody()}\n${curatedBody()}`,
    });
    const client = writeAdapters.createQueueMutationClient({ repository: REPOSITORY });
    assert.throws(() => client.updateIssueDependencies({
      endpoint: `/repos/${REPOSITORY}/issues/${READY_ISSUE}`,
      issueNumber: READY_ISSUE,
      dependencyBlock: '<!-- agent-runner:queue-dependencies:start -->\n<!-- agent-runner:queue-dependencies:end -->',
    }), /ambiguous/);
  });
});

test('the write adapter has no capability to close, merge, deploy or activate', async () => {
  await withRealComposition(async ({ writeAdapters }) => {
    for (const name of ['closeIssue', 'merge', 'mergePullRequest', 'deploy', 'activateSource', 'dispatchWorker', 'enableTimer', 'restartService']) {
      assert.equal(typeof writeAdapters[name], 'undefined', `the write adapter must not expose ${name}`);
    }
    assert.deepEqual(
      Object.keys(writeAdapters).sort(),
      ['createIssueComment', 'createQueueMutationClient', 'listIssueComments'],
    );
  });
});
