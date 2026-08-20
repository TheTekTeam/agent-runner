import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setOperatorCredential } from './agent-runner-control-auth.mjs';
import { createControlServer, listenControlServer } from './agent-runner-control-server.mjs';

const OPERATOR = { username: 'operator', password: 'unit-test-operator-password-value' };
const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DASHBOARD_JS = resolve(HERE, '../../.agent-runner/agents-dashboard/agents-dashboard.js');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'agent-runner-control-session-refresh-'));
}

async function request(baseUrl, path, { method = 'GET', body, cookie, csrfToken, origin = baseUrl } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin !== null) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { /* no/invalid body */ }
  return { status: response.status, json, setCookie: response.headers.get('set-cookie') };
}

async function startServer(paths) {
  const server = createControlServer({ ...paths });
  await listenControlServer(server, { port: 0 });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function closeServer(server) {
  return new Promise((resolvePromise) => server.close(resolvePromise));
}

test('GET /api/session rehydrates the existing cookie-backed session without creating browser persistence', async () => {
  const dir = tempDir();
  const paths = {
    settingsPath: join(dir, 'agent-settings.json'),
    secretStoreDir: join(dir, 'secrets'),
    auditPath: join(dir, 'audit.jsonl'),
    operatorCredentialPath: join(dir, 'operator.json'),
    dbPath: join(dir, 'runner-state.sqlite'),
  };
  setOperatorCredential({ ...OPERATOR, path: paths.operatorCredentialPath });
  const { server, baseUrl } = await startServer(paths);
  try {
    const login = await request(baseUrl, '/api/session/login', { method: 'POST', body: OPERATOR });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    const cookie = login.setCookie.split(';')[0];

    const context = await request(baseUrl, '/api/session', { cookie });
    assert.equal(context.status, 200, JSON.stringify(context.json));
    assert.deepEqual(Object.keys(context.json).sort(), ['csrfToken', 'expiresAtMs', 'ok', 'username']);
    assert.equal(context.json.ok, true);
    assert.equal(context.json.username, OPERATOR.username);
    assert.equal(context.json.csrfToken, login.json.csrfToken);
    assert.equal(context.json.expiresAtMs, login.json.expiresAtMs);

    const protectedRead = await request(baseUrl, '/api/instances', { cookie });
    assert.equal(protectedRead.status, 200);

    const protectedMutation = await request(baseUrl, '/api/instances', {
      method: 'POST',
      cookie,
      csrfToken: context.json.csrfToken,
      body: { agentId: 'claude-code-cli' },
    });
    assert.equal(protectedMutation.status, 201, JSON.stringify(protectedMutation.json));
  } finally {
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session-context bootstrap remains authentication/origin gated and a service restart invalidates the old cookie', async () => {
  const dir = tempDir();
  const paths = {
    settingsPath: join(dir, 'agent-settings.json'),
    secretStoreDir: join(dir, 'secrets'),
    auditPath: join(dir, 'audit.jsonl'),
    operatorCredentialPath: join(dir, 'operator.json'),
    dbPath: join(dir, 'runner-state.sqlite'),
  };
  setOperatorCredential({ ...OPERATOR, path: paths.operatorCredentialPath });

  let running = await startServer(paths);
  try {
    const anonymous = await request(running.baseUrl, '/api/session');
    assert.equal(anonymous.status, 401);

    const login = await request(running.baseUrl, '/api/session/login', { method: 'POST', body: OPERATOR });
    const cookie = login.setCookie.split(';')[0];

    const foreign = await request(running.baseUrl, '/api/session', { cookie, origin: 'http://evil.example.com' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.reason, 'origin-not-allowed');

    await closeServer(running.server);
    running = await startServer(paths);

    const afterRestart = await request(running.baseUrl, '/api/session', { cookie });
    assert.equal(afterRestart.status, 401);
    assert.equal(afterRestart.json.reason, 'session-invalid-or-expired');
  } finally {
    await closeServer(running.server).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard reload bootstrap uses the authenticated session endpoint without persisting CSRF state in browser storage', () => {
  const source = readFileSync(DASHBOARD_JS, 'utf8');
  assert.match(source, /apiFetch\('\/api\/session'\)/);
  assert.match(source, /async function bootstrapSession\(\)/);
  assert.doesNotMatch(source, /\blocalStorage\s*[.[]\s*setItem/);
  assert.doesNotMatch(source, /\bsessionStorage\s*[.[]\s*setItem/);
  assert.doesNotMatch(source, /document\.cookie\s*=/);
  assert.match(source, /bootstrapSession\(\);/);
});
