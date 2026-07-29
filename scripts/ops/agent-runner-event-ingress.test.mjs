import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  acceptGitHubWebhook,
  EventIngressStore,
  GitHubWebhookIngressError,
  verifyGitHubWebhookSignature,
} from './agent-runner-event-ingress.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';

const SECRET = 'fixture-webhook-secret-at-least-32-bytes';

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
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: ['npm test'],
    systemd: { serviceName: `${projectId}.service`, timerName: `${projectId}.timer` },
    runner: { lockPath: `.var/agent-runner/${projectId}.lock`, candidateLimit: 10 },
  };
}

function fixtureEnvironment(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-event-ingress-'));
  try {
    writeFileSync(join(dir, 'alpha.json'), JSON.stringify(projectConfig('alpha', 'Owner/Alpha', '/srv/alpha')));
    writeFileSync(join(dir, 'beta.json'), JSON.stringify(projectConfig('beta', 'Owner/Beta', '/srv/beta')));
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: ['alpha.json', 'beta.json'] }));
    const registry = loadProjectRegistry({ registryPath });
    return fn({ dir, registry, dbPath: join(dir, 'events.sqlite') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function signedRequest(payload, {
  deliveryId = 'delivery-1',
  eventName = 'pull_request',
  secret = SECRET,
} = {}) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    rawBody,
    headers: {
      'x-github-delivery': deliveryId,
      'x-github-event': eventName,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    },
  };
}

function pullRequestPayload(repository = 'Owner/Alpha') {
  return {
    action: 'closed',
    repository: { full_name: repository, default_branch: 'main' },
    pull_request: {
      number: 42,
      merged: true,
      merge_commit_sha: 'a'.repeat(40),
      head: { sha: 'b'.repeat(40), ref: 'feature' },
      base: { sha: 'c'.repeat(40), ref: 'main' },
    },
    secret: 'must-not-be-persisted',
  };
}

test('verifies valid HMAC signatures and rejects malformed signatures', () => {
  const rawBody = Buffer.from('{"ok":true}');
  const signature = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  assert.equal(verifyGitHubWebhookSignature({ rawBody, signature, secret: SECRET }), true);
  assert.equal(verifyGitHubWebhookSignature({ rawBody, signature: 'sha256=bad', secret: SECRET }), false);
});

test('accepts an enabled repository, persists a bounded envelope and deduplicates delivery IDs', () => fixtureEnvironment(({ registry, dbPath }) => {
  const store = new EventIngressStore(dbPath, { now: () => '2026-07-29T00:00:00.000Z' });
  try {
    const request = signedRequest(pullRequestPayload());
    const first = acceptGitHubWebhook({ ...request, secret: SECRET, registry, store });
    const second = acceptGitHubWebhook({ ...request, secret: SECRET, registry, store });
    assert.equal(first.status, 'accepted');
    assert.equal(second.status, 'duplicate');
    assert.equal(first.envelope.projectId, 'alpha');
    assert.equal(first.envelope.pullRequestNumber, 42);
    assert.equal(first.envelope.mergeSha, 'a'.repeat(40));
    assert.equal(store.listPending().length, 1);

    const rawDb = new DatabaseSync(dbPath, { readOnly: true });
    const stored = rawDb.prepare('SELECT event_json FROM webhook_deliveries').get();
    rawDb.close();
    assert.equal(stored.event_json.includes('must-not-be-persisted'), false);
  } finally {
    store.close();
  }
}));

test('routes a second configured project through the same ingress implementation', () => fixtureEnvironment(({ registry, dbPath }) => {
  const store = new EventIngressStore(dbPath);
  try {
    const request = signedRequest(pullRequestPayload('owner/beta'), { deliveryId: 'delivery-beta' });
    const result = acceptGitHubWebhook({ ...request, secret: SECRET, registry, store });
    assert.equal(result.envelope.projectId, 'beta');
    assert.equal(result.envelope.repository, 'Owner/Beta');
  } finally {
    store.close();
  }
}));

test('keeps push afterSha separate from PR/check headSha semantics', () => fixtureEnvironment(({ registry, dbPath }) => {
  const store = new EventIngressStore(dbPath);
  try {
    const payload = {
      repository: { full_name: 'Owner/Alpha', default_branch: 'main' },
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
    };
    const request = signedRequest(payload, { deliveryId: 'delivery-push', eventName: 'push' });
    const result = acceptGitHubWebhook({ ...request, secret: SECRET, registry, store });
    assert.equal(result.envelope.headSha, null);
    assert.equal(result.envelope.beforeSha, 'a'.repeat(40));
    assert.equal(result.envelope.afterSha, 'b'.repeat(40));
  } finally {
    store.close();
  }
}));

test('accepts a signed GitHub App ping without assigning it to a project', () => fixtureEnvironment(({ registry, dbPath }) => {
  const store = new EventIngressStore(dbPath);
  try {
    const request = signedRequest({ zen: 'Approachable is better than simple.' }, {
      deliveryId: 'delivery-app-ping',
      eventName: 'ping',
    });
    const result = acceptGitHubWebhook({ ...request, secret: SECRET, registry, store });
    assert.equal(result.status, 'accepted');
    assert.equal(result.envelope.projectId, null);
    assert.equal(result.envelope.repository, null);
    assert.equal(store.listPending()[0].eventName, 'ping');
  } finally {
    store.close();
  }
}));

test('normalizes merge-group and workflow-job evidence without project-specific logic', () => fixtureEnvironment(({ registry, dbPath }) => {
  const store = new EventIngressStore(dbPath);
  try {
    const mergeGroupPayload = {
      action: 'checks_requested',
      repository: { full_name: 'Owner/Alpha', default_branch: 'main' },
      merge_group: { head_sha: 'd'.repeat(40), base_sha: 'e'.repeat(40) },
    };
    const mergeRequest = signedRequest(mergeGroupPayload, {
      deliveryId: 'delivery-merge-group',
      eventName: 'merge_group',
    });
    const mergeResult = acceptGitHubWebhook({ ...mergeRequest, secret: SECRET, registry, store });
    assert.equal(mergeResult.envelope.headSha, 'd'.repeat(40));
    assert.equal(mergeResult.envelope.baseSha, 'e'.repeat(40));

    const workflowJobPayload = {
      action: 'completed',
      repository: { full_name: 'Owner/Alpha', default_branch: 'main' },
      workflow_job: {
        head_sha: 'f'.repeat(40),
        pull_requests: [{ number: 51 }],
      },
    };
    const jobRequest = signedRequest(workflowJobPayload, {
      deliveryId: 'delivery-workflow-job',
      eventName: 'workflow_job',
    });
    const jobResult = acceptGitHubWebhook({ ...jobRequest, secret: SECRET, registry, store });
    assert.equal(jobResult.envelope.headSha, 'f'.repeat(40));
    assert.equal(jobResult.envelope.pullRequestNumber, 51);
  } finally {
    store.close();
  }
}));

test('rejects invalid signatures, unknown repositories, unsupported actions and oversized payloads', () => fixtureEnvironment(({ registry, dbPath }) => {
  const store = new EventIngressStore(dbPath);
  try {
    const valid = signedRequest(pullRequestPayload());
    assert.throws(
      () => acceptGitHubWebhook({ ...valid, secret: 'different-secret-that-is-long-enough', registry, store }),
      (error) => error instanceof GitHubWebhookIngressError && error.code === 'invalid-signature' && error.statusCode === 401,
    );

    const unknown = signedRequest(pullRequestPayload('Owner/Unknown'), { deliveryId: 'delivery-unknown' });
    assert.throws(
      () => acceptGitHubWebhook({ ...unknown, secret: SECRET, registry, store }),
      (error) => error.code === 'unknown-repository' && error.statusCode === 404,
    );

    const unsupportedPayload = { ...pullRequestPayload(), action: 'mystery_action' };
    const unsupported = signedRequest(unsupportedPayload, { deliveryId: 'delivery-unsupported' });
    assert.throws(
      () => acceptGitHubWebhook({ ...unsupported, secret: SECRET, registry, store }),
      (error) => error.code === 'unsupported-event' && error.statusCode === 422,
    );

    const oversized = signedRequest({ ...pullRequestPayload(), padding: 'x'.repeat(2048) }, { deliveryId: 'delivery-large' });
    assert.throws(
      () => acceptGitHubWebhook({ ...oversized, secret: SECRET, registry, store, maxBodyBytes: 1024 }),
      (error) => error.code === 'payload-too-large' && error.statusCode === 413,
    );
  } finally {
    store.close();
  }
}));

test('rejects a reused delivery ID with different payload evidence', () => fixtureEnvironment(({ registry, dbPath }) => {
  const store = new EventIngressStore(dbPath);
  try {
    const first = signedRequest(pullRequestPayload(), { deliveryId: 'delivery-collision' });
    acceptGitHubWebhook({ ...first, secret: SECRET, registry, store });
    const changed = signedRequest({ ...pullRequestPayload(), action: 'reopened' }, { deliveryId: 'delivery-collision' });
    assert.throws(
      () => acceptGitHubWebhook({ ...changed, secret: SECRET, registry, store }),
      (error) => error.code === 'delivery-id-collision' && error.statusCode === 409,
    );
  } finally {
    store.close();
  }
}));

test('recovers durable pending deliveries after store restart', () => fixtureEnvironment(({ registry, dbPath }) => {
  const request = signedRequest(pullRequestPayload(), { deliveryId: 'delivery-restart' });
  const firstStore = new EventIngressStore(dbPath);
  acceptGitHubWebhook({ ...request, secret: SECRET, registry, store: firstStore });
  firstStore.close();

  const secondStore = new EventIngressStore(dbPath);
  try {
    assert.equal(secondStore.listPending().length, 1);
    const duplicate = acceptGitHubWebhook({ ...request, secret: SECRET, registry, store: secondStore });
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(secondStore.setDeliveryState('delivery-restart', 'batched'), true);
    assert.equal(secondStore.listPending().length, 0);
  } finally {
    secondStore.close();
  }
}));
