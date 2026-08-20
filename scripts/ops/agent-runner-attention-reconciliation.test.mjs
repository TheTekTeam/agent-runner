import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { GhCliAttentionReadClient } from './agent-runner-attention-github-client.mjs';
import { resolveAttentionReconciliationDbPath } from './agent-runner-attention-reconciliation-path.mjs';
import { AttentionReconciliationStore, readAttentionReconciliationState } from './agent-runner-attention-reconciliation-store.mjs';
import {
  attentionEventIdentity, attentionSourceSnapshotDigest, buildAttentionReconciliationProjection,
  classifyGithubIssueState, reconcileAttentionEvents,
} from './agent-runner-attention-reconciliation.mjs';
import { runAttentionReconciliation } from './agent-runner-attention-reconcile-command.mjs';

const REPO = 'TheTekTeam/modelspend';
const NOW = '2026-08-20T01:00:00.000Z';
const LATER = '2026-08-20T01:10:00.000Z';

function row(issueNumber, overrides = {}) {
  return {
    id: issueNumber, repo: REPO, issue_number: issueNumber, dedupe_key: `dedupe-${issueNumber}`,
    attempt_id: `attempt-${issueNumber}`, updated_at: NOW, resolved_at: null,
    recovery_status: 'forbidden', policy_revision: 'runner-recovery-v1', reason: 'attention-required',
    next_action: 'Review preserved evidence.', event_json: '{}', ...overrides,
  };
}

function attempt(issueNumber, overrides = {}) {
  return {
    attempt_id: `attempt-${issueNumber}`, attention_dedupe_key: `dedupe-${issueNumber}`,
    attention_status: 'attention_required', resolution_state: 'operator_attention_required',
    outcome: 'failed', finished_at: NOW, ...overrides,
  };
}

function fakeClient(byIdentity) {
  const calls = [];
  return {
    calls,
    getIssue(repository, issueNumber) {
      calls.push({ repository, issueNumber });
      const value = byIdentity[`${repository}#${issueNumber}`];
      if (value === 'throw') throw new Error('offline');
      return value;
    },
  };
}

function tempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'attention-reconciliation-v2-'));
  try { return fn(join(dir, 'attention.sqlite'), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function runGeneration(store, events, attempts, client, overrides = {}) {
  const times = [NOW, NOW, LATER];
  return reconcileAttentionEvents({
    repository: REPO, attentionEvents: events, attempts, store, client,
    generationId: overrides.generationId || `generation-${Math.random().toString(16).slice(2)}`,
    now: () => times.shift() || LATER, ...overrides,
  });
}

test('closed state is historical; open requires exact current runner proof', () => {
  assert.deepEqual(classifyGithubIssueState({ state: 'closed', state_reason: 'completed' }), { status: 'historical', reasonCode: 'closed-completed' });
  assert.deepEqual(classifyGithubIssueState({ state: 'open' }), { status: 'unknown', reasonCode: 'open-without-current-action-proof' });
  assert.deepEqual(classifyGithubIssueState({ state: 'open' }, { hasCurrentActionProof: true }), { status: 'actionable', reasonCode: 'current-operator-hold' });
});

test('immutable event identity separates later events for the same repository issue', () => {
  assert.notEqual(attentionEventIdentity(row(44)), attentionEventIdentity(row(44, { id: 99, dedupe_key: 'later', attempt_id: 'later' })));
});

test('repository-qualified GET cache performs one read per issue and classifies every exact event', () => {
  tempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    const events = [row(44), row(44, { id: 99, dedupe_key: 'later', attempt_id: 'later' })];
    const client = fakeClient({ [`${REPO}#44`]: { number: 44, state: 'closed', state_reason: 'completed', updated_at: NOW } });
    const state = runGeneration(store, events, [], client);
    assert.equal(client.calls.length, 1);
    assert.equal(state.items.length, 2);
    assert.ok(state.items.every((item) => item.status === 'historical'));
    store.close();
  });
});

test('open item is actionable only with matching attempt and dedupe evidence', () => {
  tempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    const client = fakeClient({ [`${REPO}#182`]: { number: 182, state: 'open', updated_at: NOW } });
    const current = runGeneration(store, [row(182)], [attempt(182)], client, { generationId: 'proof-current' });
    assert.equal(current.items[0].status, 'actionable');
    const withoutProof = runGeneration(store, [row(182)], [attempt(182, { attention_dedupe_key: 'different' })], client, { generationId: 'proof-missing' });
    assert.equal(withoutProof.items[0].status, 'unknown');
    store.close();
  });
});

test('lookup failure and cross-repository same-number lookup remain separate and unknown', () => {
  tempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    const client = fakeClient({ [`${REPO}#44`]: 'throw', 'Other/repo#44': { number: 44, state: 'open' } });
    const state = runGeneration(store, [row(44)], [], client);
    assert.equal(state.items[0].status, 'unknown');
    assert.deepEqual(client.calls, [{ repository: REPO, issueNumber: 44 }]);
    store.close();
  });
});

test('replay is idempotent and append-only transitions are not duplicated', () => {
  tempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    const client = fakeClient({ [`${REPO}#686`]: { number: 686, state: 'closed', state_reason: 'not_planned', updated_at: NOW } });
    const event = row(686);
    runGeneration(store, [event], [], client, { generationId: 'replay-one' });
    runGeneration(store, [event], [], client, { generationId: 'replay-two' });
    assert.equal(store.transitionCount(REPO, attentionEventIdentity(event)), 1);
    store.close();
  });
});

test('source change before atomic publication leaves the previous generation current', () => {
  tempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    const client = fakeClient({ [`${REPO}#743`]: { number: 743, state: 'closed', updated_at: NOW } });
    runGeneration(store, [row(743)], [], client, { generationId: 'stable-generation' });
    assert.throws(() => runGeneration(store, [row(743)], [], client, { generationId: 'changed-generation', verifySource: () => false }), /source changed/);
    assert.equal(store.listStateForRepository(REPO).generation.id, 'stable-generation');
    store.close();
  });
});

test('acknowledgement is exact-revision, expiring and append-only; newer evidence invalidates it', () => {
  tempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    const event = row(207);
    const client = fakeClient({ [`${REPO}#207`]: { number: 207, state: 'open', updated_at: NOW } });
    let state = runGeneration(store, [event], [], client, { generationId: 'ack-one' });
    const item = state.items[0];
    store.acknowledge({ repository: REPO, eventKey: item.eventKey, eventRevision: item.eventRevision,
      githubEvidenceRevision: item.githubEvidenceRevision, status: 'actionable', reasonCode: 'manager-confirmed-actionable',
      actor: 'operator:gp', now: NOW, expiresAt: '2026-08-21T01:00:00.000Z' });
    state = store.listStateForRepository(REPO);
    assert.equal(buildAttentionReconciliationProjection([event], [], state, { repository: REPO, now: LATER }).counts.actionable, 1);
    client.getIssue = () => ({ number: 207, state: 'open', updated_at: LATER });
    state = runGeneration(store, [event], [], client, { generationId: 'ack-two' });
    assert.equal(buildAttentionReconciliationProjection([event], [], state, { repository: REPO, now: LATER }).counts.actionable, 0);
    assert.equal(state.acknowledgements.filter((ack) => ack.action === 'grant').length, 1);
    store.close();
  });
});

test('acknowledgement revocation is append-only and closed items require an explicit post-closure reason', () => {
  tempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    const openEvent = row(208);
    let state = runGeneration(store, [openEvent], [], fakeClient({
      [`${REPO}#208`]: { number: 208, state: 'open', updated_at: NOW },
    }), { generationId: 'revoke-one' });
    const openItem = state.items[0];
    const grant = store.acknowledge({ repository: REPO, eventKey: openItem.eventKey,
      eventRevision: openItem.eventRevision, githubEvidenceRevision: openItem.githubEvidenceRevision,
      status: 'actionable', reasonCode: 'manager-confirmed-actionable', actor: 'operator:gp',
      now: NOW, expiresAt: '2026-08-21T01:00:00.000Z' });
    store.revokeAcknowledgement({ acknowledgementId: grant.id, actor: 'operator:gp', now: LATER });
    state = store.listStateForRepository(REPO);
    assert.equal(buildAttentionReconciliationProjection([openEvent], [], state, { repository: REPO, now: LATER }).counts.actionable, 0);
    assert.deepEqual(state.acknowledgements.map((ack) => ack.action), ['grant', 'revoke']);

    const closedEvent = row(209);
    state = runGeneration(store, [closedEvent], [], fakeClient({
      [`${REPO}#209`]: { number: 209, state: 'closed', updated_at: NOW },
    }), { generationId: 'closed-one' });
    const closedItem = state.items[0];
    assert.throws(() => store.acknowledge({ repository: REPO, eventKey: closedItem.eventKey,
      eventRevision: closedItem.eventRevision, githubEvidenceRevision: closedItem.githubEvidenceRevision,
      status: 'actionable', reasonCode: 'manager-confirmed-actionable', actor: 'operator:gp',
      now: NOW, expiresAt: '2026-08-21T01:00:00.000Z' }), /post-closure action reason/);
    assert.equal(store.acknowledge({ repository: REPO, eventKey: closedItem.eventKey,
      eventRevision: closedItem.eventRevision, githubEvidenceRevision: closedItem.githubEvidenceRevision,
      status: 'actionable', reasonCode: 'post-closure-action-required', actor: 'operator:gp',
      now: NOW, expiresAt: '2026-08-21T01:00:00.000Z' }).status, 'actionable');
    store.close();
  });
});

test('missing and expired generations project as degraded unknown/stale, never attention or clear', () => {
  const event = row(500);
  const missing = buildAttentionReconciliationProjection([event], [], null, { repository: REPO, now: NOW });
  assert.equal(missing.posture, 'degraded'); assert.equal(missing.counts.unknown, 1);
  const expired = buildAttentionReconciliationProjection([event], [], {
    generation: { id: 'old', state: 'completed', sourceSnapshotDigest: attentionSourceSnapshotDigest([event], []), expiresAt: '2026-08-20T00:00:00.000Z' },
    items: [], acknowledgements: [],
  }, { repository: REPO, now: NOW });
  assert.equal(expired.counts.stale, 1); assert.equal(expired.posture, 'degraded');
});

test('read-only state reader creates no database or sidecar and reads a completed generation', () => {
  tempDb((dbPath, dir) => {
    assert.deepEqual(readAttentionReconciliationState(join(dir, 'missing.sqlite'), REPO).items, []);
    assert.deepEqual(readdirSync(dir), []);
    const store = new AttentionReconciliationStore(dbPath);
    const client = fakeClient({ [`${REPO}#757`]: { number: 757, state: 'closed', updated_at: NOW } });
    runGeneration(store, [row(757)], [], client, { generationId: 'readable' }); store.close();
    const before = readdirSync(dir).sort();
    assert.equal(readAttentionReconciliationState(dbPath, REPO).generation.id, 'readable');
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.ok(existsSync(dbPath));
  });
});

test('GET-only client has no method surface and always spawns gh api --method GET', () => {
  const calls = [];
  let options;
  const client = new GhCliAttentionReadClient({ env: { PATH: '/bin', GH_TOKEN: 'allowed-for-gh-only', PRIVATE_SENTINEL: 'must-not-pass' }, spawn(command, args, spawnOptions) {
    calls.push({ command, args }); options = spawnOptions;
    return { status: 0, stdout: JSON.stringify({ number: 44, state: 'closed' }) };
  } });
  assert.equal(client.getIssue(REPO, 44).state, 'closed');
  assert.deepEqual(calls[0], { command: 'gh', args: ['api', '--method', 'GET', `/repos/${REPO}/issues/44`] });
  assert.equal(options.timeout, 3_000); assert.equal(options.env.PRIVATE_SENTINEL, undefined);
  assert.equal('request' in client, false);
});

test('lookup budget stops issuing GETs and classifies remaining exact events unknown', () => {
  tempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    let clockMs = 0; let calls = 0;
    const client = { getIssue(repository, issueNumber) {
      calls += 1; clockMs = 16_000; return { number: issueNumber, state: 'closed', updated_at: NOW };
    } };
    const state = reconcileAttentionEvents({ repository: REPO, attentionEvents: [row(1), row(2)], attempts: [],
      store, client, clock: () => clockMs, totalLookupMs: 15_000, generationId: 'budget-one' });
    assert.equal(calls, 1);
    assert.equal(state.items.find((item) => item.issueNumber === 2).reasonCode, 'lookup-budget-exhausted');
    store.close();
  });
});

test('overflow source projects exact degraded count and never clear', () => {
  const events = Array.from({ length: 201 }, (_, index) => row(index + 1));
  const projection = buildAttentionReconciliationProjection(events, [], null, {
    repository: REPO, now: NOW, sourceTotal: 237, sourceOverflow: true,
  });
  assert.equal(projection.posture, 'degraded');
  assert.deepEqual(projection.counts, { actionable: 0, historical: 0, unknown: 237, stale: 0, total: 237 });
  assert.equal(projection.generation.freshness, 'overflow');
});

test('one path resolver honors explicit, reconciliation env, output-dir env and config in order', () => {
  assert.equal(resolveAttentionReconciliationDbPath({ explicitPath: '/explicit/db', env: {}, config: {} }), '/explicit/db');
  assert.equal(resolveAttentionReconciliationDbPath({ env: { CLAUDE_RUNNER_ATTENTION_RECONCILIATION_DB: '/env/db', CLAUDE_RUNNER_OUTPUT_DIR: '/ignored' }, config: {} }), '/env/db');
  assert.equal(resolveAttentionReconciliationDbPath({ env: { CLAUDE_RUNNER_OUTPUT_DIR: '/runtime' }, config: { outputDir: '/config' } }), join('/runtime', 'attention-reconciliation.sqlite'));
  assert.equal(resolveAttentionReconciliationDbPath({ env: {}, config: { outputDir: '/config' } }), join('/config', 'attention-reconciliation.sqlite'));
});

test('command uses output-dir override, rechecks source and writes only the dedicated store', () => {
  tempDb((dbPath) => {
    const event = row(44); let reads = 0; let createdPath = null;
    const snapshotReader = () => { reads += 1; return {
      ok: true,
      latest: { attentionEvents: [], recoveryAttempts: [] },
      attentionSource: { attentionEvents: [event], recoveryAttempts: [] },
    }; };
    const result = runAttentionReconciliation({
      env: { CLAUDE_RUNNER_OUTPUT_DIR: '/runtime' }, config: { githubRepo: REPO, outputDir: '/config' },
      snapshotReader, client: fakeClient({ [`${REPO}#44`]: { number: 44, state: 'closed', updated_at: NOW } }),
      storeFactory(path) { createdPath = path; return new AttentionReconciliationStore(dbPath); },
      now: (() => { const values = [NOW, NOW, LATER, LATER]; return () => values.shift() || LATER; })(),
    });
    assert.equal(result.historicalCount, 1); assert.equal(reads, 2);
    assert.equal(createdPath, join('/runtime', 'attention-reconciliation.sqlite'));
  });
});

test('command appends bounded superseded and failed generation outcomes without moving current truth', () => {
  tempDb((dbPath) => {
    const first = row(44); const changed = row(45); let reads = 0;
    const snapshotReader = () => {
      reads += 1;
      const event = reads === 1 ? first : changed;
      return { ok: true, latest: {}, attentionSource: { attentionEvents: [event], recoveryAttempts: [], total: 1, overflow: false } };
    };
    assert.throws(() => runAttentionReconciliation({
      argv: ['--reconciliation-db', dbPath], config: { githubRepo: REPO, outputDir: '/config' },
      snapshotReader, client: fakeClient({ [`${REPO}#44`]: { number: 44, state: 'closed', updated_at: NOW } }),
      now: () => NOW,
    }), (error) => error.code === 'attention-source-changed');
    let store = new AttentionReconciliationStore(dbPath);
    assert.deepEqual(store.generationOutcomes(REPO).map((item) => [item.state, item.failure_code]),
      [['superseded', 'attention-source-changed']]);
    store.close();

    const overflowEvents = Array.from({ length: 201 }, (_, index) => row(index + 1000));
    assert.throws(() => runAttentionReconciliation({
      argv: ['--reconciliation-db', dbPath], config: { githubRepo: REPO, outputDir: '/config' },
      snapshotReader: () => ({ ok: true, latest: {}, attentionSource: {
        attentionEvents: overflowEvents, recoveryAttempts: [], total: 201, overflow: true,
      } }), client: fakeClient({}), now: () => LATER,
    }), (error) => error.code === 'attention-event-bound-exceeded');
    store = new AttentionReconciliationStore(dbPath);
    assert.deepEqual(store.generationOutcomes(REPO).map((item) => [item.state, item.failure_code]),
      [['superseded', 'attention-source-changed'], ['failed', 'attention-event-bound-exceeded']]);
    assert.equal(store.listStateForRepository(REPO).generation, null);
    store.close();
  });
});
