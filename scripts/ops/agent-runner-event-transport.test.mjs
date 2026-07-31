import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventIngressStore } from './agent-runner-event-ingress.mjs';
import {
  EventTransportError,
  createEventTransportServer,
  loadWebhookSecret,
  validateInheritedLoopbackAddress,
} from './agent-runner-event-transport.mjs';

const SECRET = 'transport-test-secret-0123456789abcdef-0123456789abcdef';
const REPOSITORY = 'TheTekTeam/agent-runner';

function registryFixture() {
  const project = Object.freeze({ projectId: 'agent-runner', githubRepo: REPOSITORY });
  return Object.freeze({
    projectsByRepository: Object.freeze({ [REPOSITORY.toLowerCase()]: project }),
  });
}

function signature(body) {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function send({ port, method = 'POST', path = '/github/webhook', body = Buffer.alloc(0), headers = {} }) {
  return new Promise((resolveResponse, rejectResponse) => {
    const client = request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolveResponse({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    client.on('error', rejectResponse);
    if (body.length > 0) client.write(body);
    client.end();
  });
}

function githubHeaders(body, { delivery = 'delivery-1', event = 'issues', override = {} } = {}) {
  return {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'x-github-delivery': delivery,
    'x-github-event': event,
    'x-hub-signature-256': signature(body),
    ...override,
  };
}

async function startFixture(dbPath) {
  const store = new EventIngressStore(dbPath);
  const server = createEventTransportServer({ registry: registryFixture(), store, secret: SECRET });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    store,
    server,
    port: address.port,
    close: () => new Promise((resolveClose) => server.close(() => {
      store.close();
      resolveClose();
    })),
  };
}

test('health is fixed, unauthenticated and read-only', async (t) => {
  const fixture = await startFixture(':memory:');
  t.after(fixture.close);
  const response = await send({ port: fixture.port, method: 'GET', path: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { status: 'ok', schemaVersion: 1 });
  assert.deepEqual(fixture.store.listPending(), []);
});

test('preserves exact raw bytes for a valid signed issue delivery and persists before 202', async (t) => {
  const fixture = await startFixture(':memory:');
  t.after(fixture.close);
  const body = Buffer.from('{\n  "action": "opened",\n  "repository": {"full_name":"TheTekTeam/agent-runner","default_branch":"main"},\n  "issue":{"number":105}\n}\n');
  const response = await send({ port: fixture.port, body, headers: githubHeaders(body) });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(JSON.parse(response.body), { status: 'accepted' });
  const delivery = fixture.store.getDelivery('delivery-1');
  assert.equal(delivery.repository, REPOSITORY);
  assert.equal(delivery.issueNumber, 105);
  assert.equal(delivery.processingState, 'pending');
  assert.equal(delivery.event.payloadSha256, delivery.payloadSha256);
});

test('accepts a signed ping without assigning it to a project', async (t) => {
  const fixture = await startFixture(':memory:');
  t.after(fixture.close);
  const body = Buffer.from('{"zen":"safe ping"}');
  const response = await send({
    port: fixture.port,
    body,
    headers: githubHeaders(body, { delivery: 'ping-1', event: 'ping' }),
  });
  assert.equal(response.statusCode, 202);
  assert.equal(fixture.store.getDelivery('ping-1').projectId, null);
});

test('duplicate replay is idempotent and changed evidence collides', async (t) => {
  const fixture = await startFixture(':memory:');
  t.after(fixture.close);
  const first = Buffer.from('{"action":"opened","repository":{"full_name":"TheTekTeam/agent-runner"},"issue":{"number":1}}');
  const duplicate = await send({ port: fixture.port, body: first, headers: githubHeaders(first, { delivery: 'replay-1' }) });
  assert.equal(duplicate.statusCode, 202);
  const replay = await send({ port: fixture.port, body: first, headers: githubHeaders(first, { delivery: 'replay-1' }) });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(JSON.parse(replay.body), { status: 'duplicate' });

  const changed = Buffer.from('{"action":"opened","repository":{"full_name":"TheTekTeam/agent-runner"},"issue":{"number":2}}');
  const collision = await send({ port: fixture.port, body: changed, headers: githubHeaders(changed, { delivery: 'replay-1' }) });
  assert.equal(collision.statusCode, 409);
  assert.equal(JSON.parse(collision.body).code, 'delivery-id-collision');
  assert.equal(fixture.store.listPending().length, 1);
});

test('invalid signature, unknown repository and unsupported event fail closed', async (t) => {
  const fixture = await startFixture(':memory:');
  t.after(fixture.close);
  const known = Buffer.from('{"action":"opened","repository":{"full_name":"TheTekTeam/agent-runner"},"issue":{"number":3}}');
  const invalid = await send({
    port: fixture.port,
    body: known,
    headers: githubHeaders(known, { override: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` } }),
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(JSON.parse(invalid.body).code, 'invalid-signature');

  const unknown = Buffer.from('{"action":"opened","repository":{"full_name":"Other/repo"},"issue":{"number":3}}');
  const unknownResponse = await send({ port: fixture.port, body: unknown, headers: githubHeaders(unknown, { delivery: 'unknown-1' }) });
  assert.equal(unknownResponse.statusCode, 404);
  assert.equal(JSON.parse(unknownResponse.body).code, 'unknown-repository');

  const unsupported = Buffer.from('{"action":"created","repository":{"full_name":"TheTekTeam/agent-runner"}}');
  const unsupportedResponse = await send({
    port: fixture.port,
    body: unsupported,
    headers: githubHeaders(unsupported, { delivery: 'unsupported-1', event: 'deployment' }),
  });
  assert.equal(unsupportedResponse.statusCode, 422);
  assert.equal(JSON.parse(unsupportedResponse.body).code, 'unsupported-event');
  assert.deepEqual(fixture.store.listPending(), []);
});

test('oversized body, duplicate security headers, unsupported method and unknown path are rejected', async (t) => {
  const fixture = await startFixture(':memory:');
  t.after(fixture.close);
  const oversizedBody = Buffer.alloc(1024 * 1024 + 1, 0x61);
  const tooLarge = await send({
    port: fixture.port,
    body: oversizedBody,
    headers: githubHeaders(oversizedBody),
  });
  assert.equal(tooLarge.statusCode, 413);

  const body = Buffer.from('{}');
  const duplicateHeaders = await send({
    port: fixture.port,
    body,
    headers: [
      'content-length', String(body.length),
      'x-github-delivery', 'duplicate-header-1',
      'x-github-delivery', 'duplicate-header-2',
      'x-github-event', 'ping',
      'x-hub-signature-256', signature(body),
    ],
  });
  assert.equal(duplicateHeaders.statusCode, 400);

  const wrongMethod = await send({ port: fixture.port, method: 'GET', path: '/github/webhook' });
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  const missing = await send({ port: fixture.port, method: 'GET', path: '/anything' });
  assert.equal(missing.statusCode, 404);
});

test('durable duplicate identity survives server and store restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-event-transport-'));
  const dbPath = join(directory, 'controller.sqlite');
  try {
    const body = Buffer.from('{"action":"opened","repository":{"full_name":"TheTekTeam/agent-runner"},"issue":{"number":4}}');
    const first = await startFixture(dbPath);
    const accepted = await send({ port: first.port, body, headers: githubHeaders(body, { delivery: 'restart-1' }) });
    assert.equal(accepted.statusCode, 202);
    await first.close();

    const second = await startFixture(dbPath);
    const replay = await send({ port: second.port, body, headers: githubHeaders(body, { delivery: 'restart-1' }) });
    assert.equal(replay.statusCode, 200);
    assert.equal(second.store.listPending().length, 1);
    await second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('secret loader requires an owner-only regular file and never returns path metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-event-secret-'));
  const secretPath = join(directory, 'webhook-secret');
  try {
    writeFileSync(secretPath, `${SECRET}\n`, { mode: 0o600 });
    assert.equal(loadWebhookSecret(secretPath), SECRET);
    chmodSync(secretPath, 0o640);
    assert.throws(() => loadWebhookSecret(secretPath), (error) => {
      assert.equal(error.code, 'secret-permissions-too-open');
      assert.equal(error.message.includes(secretPath), false);
      return true;
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inherited socket validation accepts only unprivileged IPv4 loopback', () => {
  assert.equal(validateInheritedLoopbackAddress({ address: '127.0.0.1', family: 'IPv4', port: 8787 }), true);
  assert.throws(
    () => validateInheritedLoopbackAddress({ address: '0.0.0.0', family: 'IPv4', port: 8787 }),
    (error) => error instanceof EventTransportError && error.code === 'inherited-socket-not-loopback',
  );
  assert.throws(
    () => validateInheritedLoopbackAddress({ address: '127.0.0.1', family: 'IPv4', port: 443 }),
    (error) => error instanceof EventTransportError && error.code === 'inherited-socket-port-invalid',
  );
});

test('source and systemd units preserve the no-execution and loopback-only boundary', () => {
  const source = readFileSync(new URL('./agent-runner-event-transport.mjs', import.meta.url), 'utf8');
  const socketUnit = readFileSync(new URL('../../systemd/user/agent-runner-event-ingress.socket', import.meta.url), 'utf8');
  const serviceUnit = readFileSync(new URL('../../systemd/user/agent-runner-event-ingress.service', import.meta.url), 'utf8');
  assert.match(source, /server\.listen\(\{ fd: options\.listenFd \}/);
  assert.doesNotMatch(source, /child_process|spawn\(|exec\(|GhCliGitHubWrite|queue-triage/);
  assert.match(socketUnit, /ListenStream=127\.0\.0\.1:8787/);
  assert.doesNotMatch(socketUnit, /0\.0\.0\.0|\[::\]|ListenDatagram/);
  assert.match(serviceUnit, /--listen-fd 3/);
  assert.match(serviceUnit, /RestrictAddressFamilies=AF_INET/);
  assert.match(serviceUnit, /NoNewPrivileges=true/);
  assert.match(serviceUnit, /ProtectSystem=strict/);
  assert.match(serviceUnit, /ProtectHome=read-only/);
});
