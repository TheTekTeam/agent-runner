import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AttentionReconciliationStore, readAttentionReconciliationsForRepository } from './agent-runner-attention-reconciliation-store.mjs';
import {
  classifyGithubIssueState, reconcileAttentionIdentity, distinctUnresolvedAttentionIdentities,
  reconcileAttentionEvents, attentionReconciliationLookup, effectiveAttentionReconciliationStatus,
} from './agent-runner-attention-reconciliation.mjs';
import { buildRunnerOperatorStatus } from './claude-runner-dashboard-api.mjs';
import { projectAttention } from './agent-runner-control-overview.mjs';

function fakeClient(issuesByNumber) {
  const calls = [];
  return {
    calls,
    request(method, endpoint) {
      calls.push({ method, endpoint });
      const match = endpoint.match(/\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
      if (!match) throw new Error('unexpected endpoint');
      const [, , numberText] = match;
      const number = Number(numberText);
      if (!(number in issuesByNumber)) return null;
      const issue = issuesByNumber[number];
      if (issue === 'throw') throw new Error('network unavailable');
      return issue;
    },
  };
}

function attentionRow({ repo = 'TheTekTeam/modelspend', issueNumber, resolvedAt = null } = {}) {
  return { repo, issue_number: issueNumber, resolved_at: resolvedAt };
}

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'attention-reconciliation-'));
  try {
    return fn(join(dir, 'attention-reconciliation.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('classifyGithubIssueState: closed issue is historical regardless of close reason', () => {
  assert.deepEqual(classifyGithubIssueState({ state: 'closed', state_reason: 'completed' }), { status: 'historical', reasonCode: 'closed-completed' });
  assert.deepEqual(classifyGithubIssueState({ state: 'closed', state_reason: 'not_planned' }), { status: 'historical', reasonCode: 'closed-not_planned' });
  assert.deepEqual(classifyGithubIssueState({ state: 'closed', state_reason: null }), { status: 'historical', reasonCode: 'closed-unspecified' });
});

test('classifyGithubIssueState: open issue is actionable', () => {
  assert.deepEqual(classifyGithubIssueState({ state: 'open', state_reason: null }), { status: 'actionable', reasonCode: 'issue-open' });
});

test('classifyGithubIssueState: missing/malformed issue fails closed to unknown, never healthy', () => {
  assert.equal(classifyGithubIssueState(null).status, 'unknown');
  assert.equal(classifyGithubIssueState({}).status, 'unknown');
  assert.equal(classifyGithubIssueState({ state: 'merged' }).status, 'unknown');
});

test('reconcileAttentionIdentity: GitHub lookup unavailable fails closed to unknown', () => {
  const client = fakeClient({ 44: 'throw' });
  const decision = reconcileAttentionIdentity({ repository: 'TheTekTeam/modelspend', issueNumber: 44, client });
  assert.equal(decision.status, 'unknown');
  assert.equal(decision.reasonCode, 'lookup-unavailable');
});

test('reconcileAttentionIdentity: repository-qualified -- rejects a bare/invalid repository identity', () => {
  const client = fakeClient({});
  const decision = reconcileAttentionIdentity({ repository: 'not-a-repo', issueNumber: 44, client });
  assert.equal(decision.status, 'unknown');
  assert.equal(decision.reasonCode, 'invalid-repository');
  assert.equal(client.calls.length, 0);
});

test('distinctUnresolvedAttentionIdentities: repository-qualified de-duplication, excludes already-resolved rows', () => {
  const rows = [
    attentionRow({ issueNumber: 182 }),
    attentionRow({ issueNumber: 182 }),
    attentionRow({ repo: 'Other/repo', issueNumber: 182 }),
    attentionRow({ issueNumber: 44, resolvedAt: '2026-01-01T00:00:00.000Z' }),
  ];
  const identities = distinctUnresolvedAttentionIdentities(rows);
  assert.deepEqual(
    identities.sort((a, b) => a.repository.localeCompare(b.repository) || a.issueNumber - b.issueNumber),
    [
      { repository: 'Other/repo', issueNumber: 182 },
      { repository: 'TheTekTeam/modelspend', issueNumber: 182 },
    ],
  );
});

test('reconcileAttentionEvents: closed issue becomes historical without deleting the original attention evidence', () => {
  withTempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    try {
      const attentionEvents = [attentionRow({ issueNumber: 44 })];
      const client = fakeClient({ 44: { number: 44, state: 'closed', state_reason: 'completed' } });
      const results = reconcileAttentionEvents({ attentionEvents, store, client, now: () => '2026-08-18T00:00:00.000Z' });
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'historical');
      assert.equal(results[0].reasonCode, 'closed-completed');

      // Original attention_events-shaped evidence is untouched by this module.
      assert.equal(attentionEvents[0].repo, 'TheTekTeam/modelspend');
      assert.equal(attentionEvents[0].issue_number, 44);
      assert.equal(attentionEvents[0].resolved_at, null);

      const stored = store.get('TheTekTeam/modelspend', 44);
      assert.equal(stored.status, 'historical');
    } finally {
      store.close();
    }
  });
});

test('reconcileAttentionEvents: open issue remains actionable/unresolved', () => {
  withTempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    try {
      const attentionEvents = [attentionRow({ issueNumber: 182 })];
      const client = fakeClient({ 182: { number: 182, state: 'open', state_reason: null } });
      const results = reconcileAttentionEvents({ attentionEvents, store, client, now: () => '2026-08-18T00:00:00.000Z' });
      assert.equal(results[0].status, 'actionable');
    } finally {
      store.close();
    }
  });
});

test('reconcileAttentionEvents: lookup failure records unknown, never historical', () => {
  withTempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    try {
      const attentionEvents = [attentionRow({ issueNumber: 999 })];
      const client = fakeClient({ 999: 'throw' });
      const results = reconcileAttentionEvents({ attentionEvents, store, client, now: () => '2026-08-18T00:00:00.000Z' });
      assert.equal(results[0].status, 'unknown');
    } finally {
      store.close();
    }
  });
});

test('reconcileAttentionEvents is idempotent: repeated reconciliation against unchanged GitHub state re-verifies without changing the decision', () => {
  withTempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    try {
      const attentionEvents = [attentionRow({ issueNumber: 686 })];
      const client = fakeClient({ 686: { number: 686, state: 'closed', state_reason: 'not_planned' } });
      reconcileAttentionEvents({ attentionEvents, store, client, now: () => '2026-08-18T00:00:00.000Z' });
      const second = reconcileAttentionEvents({ attentionEvents, store, client, now: () => '2026-08-18T01:00:00.000Z' });
      assert.equal(second[0].status, 'historical');
      assert.equal(second[0].reconciliationCount, 2);

      const stored = store.get('TheTekTeam/modelspend', 686);
      assert.equal(stored.reconciliationCount, 2);
      assert.equal(stored.status, 'historical');
    } finally {
      store.close();
    }
  });
});

test('reconcileAttentionEvents performs no GitHub mutation -- every recorded call is a GET', () => {
  withTempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    try {
      const attentionEvents = [attentionRow({ issueNumber: 743 }), attentionRow({ issueNumber: 757 })];
      const client = fakeClient({
        743: { number: 743, state: 'closed', state_reason: 'completed' },
        757: { number: 757, state: 'closed', state_reason: 'completed' },
      });
      reconcileAttentionEvents({ attentionEvents, store, client, now: () => '2026-08-18T00:00:00.000Z' });
      assert.ok(client.calls.length > 0);
      for (const call of client.calls) assert.equal(call.method, 'GET');
    } finally {
      store.close();
    }
  });
});

test('AttentionReconciliationStore: repository identity prevents cross-repository issue-number collisions', () => {
  withTempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    try {
      store.upsert({ repository: 'TheTekTeam/modelspend', issueNumber: 44, status: 'historical', reasonCode: 'closed-completed', now: '2026-08-18T00:00:00.000Z' });
      store.upsert({ repository: 'Other/repo', issueNumber: 44, status: 'actionable', reasonCode: 'issue-open', now: '2026-08-18T00:00:00.000Z' });
      assert.equal(store.get('TheTekTeam/modelspend', 44).status, 'historical');
      assert.equal(store.get('Other/repo', 44).status, 'actionable');
      assert.equal(store.listForRepository('TheTekTeam/modelspend').length, 1);
    } finally {
      store.close();
    }
  });
});

test('AttentionReconciliationStore: explicit operator acknowledgement is audited and overrides the automatic decision', () => {
  withTempDb((dbPath) => {
    const store = new AttentionReconciliationStore(dbPath);
    try {
      store.upsert({ repository: 'TheTekTeam/modelspend', issueNumber: 207, status: 'actionable', reasonCode: 'issue-open', now: '2026-08-18T00:00:00.000Z' });
      const acknowledged = store.acknowledge({
        repository: 'TheTekTeam/modelspend', issueNumber: 207, status: 'historical', reasonCode: 'manager-confirmed-superseded', actor: 'operator:gp', now: '2026-08-18T01:00:00.000Z',
      });
      assert.equal(acknowledged.acknowledgedStatus, 'historical');
      assert.equal(acknowledged.acknowledgedBy, 'operator:gp');
      // The automatic decision itself is preserved, not overwritten.
      assert.equal(acknowledged.status, 'actionable');
    } finally {
      store.close();
    }
  });
});

test('readAttentionReconciliationsForRepository: read-only, missing DB yields empty (never an error, never a write)', () => {
  const result = readAttentionReconciliationsForRepository('/nonexistent/attention-reconciliation.sqlite', 'TheTekTeam/modelspend');
  assert.deepEqual(result, []);
});

test('effectiveAttentionReconciliationStatus: no reconciliation record yet keeps a row counted (no opinion, not resolved)', () => {
  const map = attentionReconciliationLookup([], 'TheTekTeam/modelspend');
  assert.equal(effectiveAttentionReconciliationStatus(attentionRow({ issueNumber: 5 }), map), null);
});

test('canonical status projection: historical reconciliation removes closed items from attention_required count while open items remain', () => {
  const latest = {
    attentionEvents: [
      attentionRow({ issueNumber: 182 }), // open, actionable
      attentionRow({ issueNumber: 207 }), // open, actionable
      attentionRow({ issueNumber: 44 }), // closed, historical
      attentionRow({ issueNumber: 686 }), // closed, historical
      attentionRow({ issueNumber: 743 }), // closed, historical
      attentionRow({ issueNumber: 757 }), // closed, historical
    ],
    queueEvents: [],
    runResults: [],
  };
  const reconciliations = attentionReconciliationLookup([
    { repository: 'TheTekTeam/modelspend', issueNumber: 182, status: 'actionable', acknowledgedStatus: null },
    { repository: 'TheTekTeam/modelspend', issueNumber: 207, status: 'actionable', acknowledgedStatus: null },
    { repository: 'TheTekTeam/modelspend', issueNumber: 44, status: 'historical', acknowledgedStatus: null },
    { repository: 'TheTekTeam/modelspend', issueNumber: 686, status: 'historical', acknowledgedStatus: null },
    { repository: 'TheTekTeam/modelspend', issueNumber: 743, status: 'historical', acknowledgedStatus: null },
    { repository: 'TheTekTeam/modelspend', issueNumber: 757, status: 'historical', acknowledgedStatus: null },
  ], 'TheTekTeam/modelspend');

  const activity = { activeIssue: null };
  const operatorStatus = buildRunnerOperatorStatus(latest, activity, [], reconciliations);
  assert.equal(operatorStatus.code, 'attention_required');
  assert.equal(operatorStatus.count, 2);

  const projected = projectAttention(latest.attentionEvents, reconciliations);
  assert.equal(projected.unresolvedCount, 2);
  assert.deepEqual(projected.events.map((event) => event.issueNumber).sort((a, b) => a - b), [182, 207]);
});

test('canonical status projection: an unknown reconciliation never removes an attention row from the count', () => {
  const latest = { attentionEvents: [attentionRow({ issueNumber: 500 })], queueEvents: [], runResults: [] };
  const reconciliations = attentionReconciliationLookup([
    { repository: 'TheTekTeam/modelspend', issueNumber: 500, status: 'unknown', acknowledgedStatus: null },
  ], 'TheTekTeam/modelspend');
  const operatorStatus = buildRunnerOperatorStatus(latest, { activeIssue: null }, [], reconciliations);
  assert.equal(operatorStatus.code, 'attention_required');
  assert.equal(operatorStatus.count, 1);
});

test('canonical status projection: with no reconciliation data at all, behavior is unchanged from before #183', () => {
  const latest = { attentionEvents: [attentionRow({ issueNumber: 44 })], queueEvents: [], runResults: [] };
  const operatorStatus = buildRunnerOperatorStatus(latest, { activeIssue: null }, []);
  assert.equal(operatorStatus.code, 'attention_required');
  assert.equal(operatorStatus.count, 1);
});
