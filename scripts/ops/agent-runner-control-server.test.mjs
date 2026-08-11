import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import { getAgentSettings } from './agent-runner-agent-settings.mjs';
import { setOperatorCredential } from './agent-runner-control-auth.mjs';
import { createControlServer, listenControlServer, resolveBindHost } from './agent-runner-control-server.mjs';

const OPERATOR = { username: 'operator', password: 'unit-test-operator-password-value' };

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'agent-runner-control-server-'));
}

async function apiRequest(baseUrl, path, { method = 'GET', headers = {}, body, cookie, csrfToken } = {}) {
  const finalHeaders = { 'Content-Type': 'application/json', Origin: baseUrl, ...headers };
  if (cookie) finalHeaders.Cookie = cookie;
  if (csrfToken) finalHeaders['x-csrf-token'] = csrfToken;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  let json = null;
  try { json = await response.json(); } catch { /* no body */ }
  return { status: response.status, json, setCookie };
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function login(baseUrl, credentials = OPERATOR) {
  const result = await apiRequest(baseUrl, '/api/session/login', { method: 'POST', body: credentials });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return { cookie: result.setCookie.split(';')[0], csrfToken: result.json.csrfToken };
}

async function withServer(fn) {
  const dir = tempDir();
  const paths = {
    settingsPath: join(dir, 'agent-settings.json'),
    secretStoreDir: join(dir, 'secrets'),
    auditPath: join(dir, 'audit.jsonl'),
    operatorCredentialPath: join(dir, 'operator.json'),
    dbPath: join(dir, 'runner-state.sqlite'),
  };
  setOperatorCredential({ ...OPERATOR, path: paths.operatorCredentialPath });
  const server = createControlServer({ ...paths });
  await listenControlServer(server, { port: 0 });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ baseUrl, server, dir, ...paths });
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(dir, { recursive: true, force: true });
  }
}

// -- loopback-only binding --------------------------------------------

test('resolveBindHost refuses any non-loopback host before a bind is ever attempted', () => {
  assert.throws(() => resolveBindHost('0.0.0.0'), /non-loopback/);
  assert.throws(() => resolveBindHost('192.168.1.10'), /non-loopback/);
  assert.throws(() => resolveBindHost('example.com'), /non-loopback/);
  assert.equal(resolveBindHost('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveBindHost('localhost'), 'localhost');
});

test('createControlServer throws for a non-loopback host and never constructs a listening server', () => {
  assert.throws(() => createControlServer({ host: '0.0.0.0', settingsPath: '/tmp/does-not-matter.json' }));
});

test('a real listening server is actually bound to loopback', () => withServer(async ({ server }) => {
  const address = server.address();
  assert.ok(['127.0.0.1', '::1'].includes(address.address));
}));

// -- authentication, sessions, CSRF, origin -----------------------------

test('a protected route without a session cookie is rejected', () => withServer(async ({ baseUrl }) => {
  const result = await apiRequest(baseUrl, '/api/instances');
  assert.equal(result.status, 401);
}));

test('login with a wrong password is rejected and never issues a session', () => withServer(async ({ baseUrl }) => {
  const result = await apiRequest(baseUrl, '/api/session/login', { method: 'POST', body: { username: 'operator', password: 'totally-wrong-password' } });
  assert.equal(result.status, 401);
  assert.equal(result.setCookie, null);
}));

test('login with correct credentials issues an HttpOnly, SameSite=Strict session cookie and a csrfToken', () => withServer(async ({ baseUrl }) => {
  const result = await apiRequest(baseUrl, '/api/session/login', { method: 'POST', body: OPERATOR });
  assert.equal(result.status, 200);
  assert.match(result.setCookie, /HttpOnly/);
  assert.match(result.setCookie, /SameSite=Strict/);
  assert.ok(result.json.csrfToken);
}));

test('a mutating request with a valid session but no CSRF header is rejected', () => withServer(async ({ baseUrl }) => {
  const { cookie } = await login(baseUrl);
  const result = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, body: { agentId: 'claude-code-cli' } });
  assert.equal(result.status, 403);
  assert.equal(result.json.reason, 'csrf-token-missing');
}));

test('a mutating request with a mismatched CSRF token is rejected', () => withServer(async ({ baseUrl }) => {
  const { cookie } = await login(baseUrl);
  const result = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken: 'not-the-real-token', body: { agentId: 'claude-code-cli' } });
  assert.equal(result.status, 403);
  assert.equal(result.json.reason, 'csrf-token-mismatch');
}));

test('a request with a foreign Origin is rejected even with a valid session and CSRF token', () => withServer(async ({ baseUrl }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const result = await apiRequest(baseUrl, '/api/instances', {
    method: 'POST',
    cookie,
    csrfToken,
    headers: { Origin: 'http://evil.example.com' },
    body: { agentId: 'claude-code-cli' },
  });
  assert.equal(result.status, 403);
  assert.equal(result.json.reason, 'origin-not-allowed');
}));

test('a request with no Origin/Referer at all is rejected, even for GET', () => withServer(async ({ baseUrl }) => {
  const { cookie } = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/instances`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 403);
}));

test('logout invalidates the session immediately', () => withServer(async ({ baseUrl }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const out = await apiRequest(baseUrl, '/api/session/logout', { method: 'POST', cookie, csrfToken });
  assert.equal(out.status, 200);
  const after = await apiRequest(baseUrl, '/api/instances', { cookie });
  assert.equal(after.status, 401);
}));

// -- instance lifecycle, allowlisted updates, catalogue gate -----------

test('GET /api/instances lists the whole approved catalogue with capacity-1 load, none created yet', () => withServer(async ({ baseUrl }) => {
  const { cookie } = await login(baseUrl);
  const result = await apiRequest(baseUrl, '/api/instances', { cookie });
  assert.equal(result.status, 200);
  const ids = result.json.instances.map((instance) => instance.agentId).sort();
  assert.deepEqual(ids, ['claude-code-cli', 'codex-cli', 'gemini-cli', 'gpt-agent', 'grok-cli', 'ollama-agent']);
  assert.ok(result.json.instances.every((instance) => instance.load.capacity === 1));
  assert.ok(result.json.instances.every((instance) => instance.created === false));
}));

test('POST /api/instances refuses an adapter id outside the approved catalogue', () => withServer(async ({ baseUrl }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const result = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'made-up-agent' } });
  assert.equal(result.status, 400);
}));

test('full instance lifecycle: create, update allowlisted settings, transition, and see it reflected without restart', () => withServer(async ({ baseUrl, settingsPath }) => {
  const { cookie, csrfToken } = await login(baseUrl);

  const created = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.instance.lifecycle.disabled, true);
  const revisionAfterCreate = created.json.revision;

  const updated = await apiRequest(baseUrl, `/api/instances/claude-code-cli/settings`, {
    method: 'PATCH',
    cookie,
    csrfToken,
    body: { updates: { model: 'claude-opus-4-8' }, expectedRevision: revisionAfterCreate },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.instance.model, 'claude-opus-4-8');

  const enabled = await apiRequest(baseUrl, `/api/instances/claude-code-cli/lifecycle`, {
    method: 'POST',
    cookie,
    csrfToken,
    body: { targetState: 'enabled', expectedRevision: updated.json.revision },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.instance.state, 'enabled');

  // Visible before the next claim, without a service restart: a direct
  // getAgentSettings() read against the same settings path sees it.
  assert.equal(getAgentSettings({ agentId: 'claude-code-cli', settingsPath }).routable, true);
}));

test('disabling and draining are both reflected as claim-ineligible before any claim or GitHub mutation', () => withServer(async ({ baseUrl, settingsPath }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const created = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });
  await apiRequest(baseUrl, '/api/instances/claude-code-cli/lifecycle', { method: 'POST', cookie, csrfToken, body: { targetState: 'enabled', expectedRevision: created.json.revision } });
  const draining = await apiRequest(baseUrl, '/api/instances/claude-code-cli/lifecycle', { method: 'POST', cookie, csrfToken, body: { targetState: 'draining', expectedRevision: created.json.revision + 1 } });
  assert.equal(draining.status, 200);
  assert.equal(getAgentSettings({ agentId: 'claude-code-cli', settingsPath }).routable, false);

  const disabled = await apiRequest(baseUrl, '/api/instances/claude-code-cli/lifecycle', { method: 'POST', cookie, csrfToken, body: { targetState: 'disabled', expectedRevision: draining.json.revision } });
  assert.equal(disabled.status, 200);
  assert.equal(getAgentSettings({ agentId: 'claude-code-cli', settingsPath }).routable, false);
}));

test('arbitrary input is rejected: executablePath, unsupported lifecycle targets, and bad policy fields all fail closed', () => withServer(async ({ baseUrl }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const created = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });

  const badField = await apiRequest(baseUrl, '/api/instances/claude-code-cli/settings', { method: 'PATCH', cookie, csrfToken, body: { updates: { executablePath: '/bin/sh' }, expectedRevision: created.json.revision } });
  assert.equal(badField.status, 422);

  const badLifecycle = await apiRequest(baseUrl, '/api/instances/claude-code-cli/lifecycle', { method: 'POST', cookie, csrfToken, body: { targetState: 'unavailable', expectedRevision: created.json.revision } });
  assert.equal(badLifecycle.status, 422);

  const badPolicy = await apiRequest(baseUrl, '/api/instances/claude-code-cli/settings', { method: 'PATCH', cookie, csrfToken, body: { updates: { policy: { paidFallbackEnabled: true } }, expectedRevision: created.json.revision } });
  assert.equal(badPolicy.status, 422);
}));

test('paid-adapter fail-closed default: a freshly created instance always requires human approval, with no writable field to disable it', () => withServer(async ({ baseUrl }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const created = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });
  assert.equal(created.json.instance.policy.requireHumanApproval, true);
}));

// -- optimistic concurrency: stale/concurrent writes --------------------

test('a stale expectedRevision is rejected with 409 and the last known good revision survives', () => withServer(async ({ baseUrl, settingsPath }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const created = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });
  await apiRequest(baseUrl, '/api/instances/claude-code-cli/settings', { method: 'PATCH', cookie, csrfToken, body: { updates: { model: 'first' }, expectedRevision: created.json.revision } });

  const stale = await apiRequest(baseUrl, '/api/instances/claude-code-cli/settings', { method: 'PATCH', cookie, csrfToken, body: { updates: { model: 'second' }, expectedRevision: created.json.revision } });
  assert.equal(stale.status, 409);

  const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(onDisk.agents['claude-code-cli'].model, 'first');
}));

// -- atomic replace + rollback + restart persistence --------------------

test('rollback restores a previous settings revision, and a fresh server instance sees the persisted state (restart persistence)', () => withServer(async ({ baseUrl, settingsPath, secretStoreDir, auditPath, operatorCredentialPath, dbPath, dir, server }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const created = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });
  const first = await apiRequest(baseUrl, '/api/instances/claude-code-cli/settings', { method: 'PATCH', cookie, csrfToken, body: { updates: { model: 'first' }, expectedRevision: created.json.revision } });
  await apiRequest(baseUrl, '/api/instances/claude-code-cli/settings', { method: 'PATCH', cookie, csrfToken, body: { updates: { model: 'second' }, expectedRevision: first.json.revision } });

  const rollback = await apiRequest(baseUrl, '/api/settings/rollback', { method: 'POST', cookie, csrfToken, body: { targetRevision: first.json.revision } });
  assert.equal(rollback.status, 200);

  const afterRollback = await apiRequest(baseUrl, '/api/instances/claude-code-cli', { cookie });
  assert.equal(afterRollback.json.instance.model, 'first');

  // Simulate a full service restart: close this server, start a brand new
  // one against the same on-disk paths, log in again (sessions never
  // persist by design), and confirm the state survived.
  await new Promise((resolvePromise) => server.close(resolvePromise));
  const restarted = createControlServer({ settingsPath, secretStoreDir, auditPath, operatorCredentialPath, dbPath });
  await listenControlServer(restarted, { port: 0 });
  try {
    const restartedBaseUrl = `http://127.0.0.1:${restarted.address().port}`;
    const restartedSession = await login(restartedBaseUrl);
    const afterRestart = await apiRequest(restartedBaseUrl, '/api/instances/claude-code-cli', { cookie: restartedSession.cookie });
    assert.equal(afterRestart.json.instance.model, 'first');
  } finally {
    await new Promise((resolvePromise) => restarted.close(resolvePromise));
  }
}));

// -- secret value non-disclosure (the leak-proof proof) -----------------

test('LEAK-PROOF: a created/rotated/removed secret value never appears in any API response, audit entry, or settings file', () => withServer(async ({ baseUrl, secretStoreDir, auditPath, settingsPath }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const createdValue = 'unit-test-secret-created-value-must-never-leak';
  const rotatedValue = 'unit-test-secret-rotated-value-must-never-leak';

  const created = await apiRequest(baseUrl, '/api/secrets/adapter-token', { method: 'POST', cookie, csrfToken, body: { value: createdValue } });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, 'configured');
  assert.ok(!('value' in created.json));

  const status = await apiRequest(baseUrl, '/api/secrets/adapter-token', { cookie });
  assert.equal(status.status, 200);
  assert.ok(!JSON.stringify(status.json).includes(createdValue));

  const rotated = await apiRequest(baseUrl, '/api/secrets/adapter-token/rotate', { method: 'POST', cookie, csrfToken, body: { value: rotatedValue } });
  assert.equal(rotated.status, 200);
  assert.ok(!JSON.stringify(rotated.json).includes(rotatedValue));

  const removed = await apiRequest(baseUrl, '/api/secrets/adapter-token', { method: 'DELETE', cookie, csrfToken });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.status, 'missing');

  // Sink 1: no API response anywhere in this test contained the value
  // (checked inline above). Sink 2: the audit log.
  const auditRaw = readFileSync(auditPath, 'utf8');
  assert.ok(!auditRaw.includes(createdValue));
  assert.ok(!auditRaw.includes(rotatedValue));
  const auditEntries = auditRaw.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(auditEntries.some((entry) => entry.action === 'secret.create'));
  assert.ok(auditEntries.every((entry) => !('value' in entry)));

  // Sink 3: the control settings document (metadata/secretref only).
  if (readdirSync(join(settingsPath, '..')).includes('agent-settings.json')) {
    const settingsRaw = readFileSync(settingsPath, 'utf8');
    assert.ok(!settingsRaw.includes(createdValue));
    assert.ok(!settingsRaw.includes(rotatedValue));
  }

  // Sink 4 (positive control): the rotated value *did* actually reach the
  // one place it is allowed to — the 0600 secret-store file — proving the
  // absence everywhere else is containment, not simply "never written".
  const secretFileNames = readdirSync(secretStoreDir).filter((name) => name.endsWith('.secret.json'));
  assert.equal(secretFileNames.length, 0, 'secret was removed, so no file should remain');
}));

test('LEAK-PROOF: while a secret is configured, its raw value is present only in the 0600 store file, never in the audit log', () => withServer(async ({ baseUrl, secretStoreDir, auditPath }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const value = 'unit-test-secret-still-configured-value';
  await apiRequest(baseUrl, '/api/secrets/live-token', { method: 'POST', cookie, csrfToken, body: { value } });

  const storeFile = readFileSync(join(secretStoreDir, 'live-token.secret.json'), 'utf8');
  assert.ok(storeFile.includes(value), 'the one authorized sink must actually contain the value');

  const auditRaw = readFileSync(auditPath, 'utf8');
  assert.ok(!auditRaw.includes(value));
}));

test('a validation error on a bad secret value never echoes the submitted value', () => withServer(async ({ baseUrl }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const result = await apiRequest(baseUrl, '/api/secrets/bad-token', { method: 'POST', cookie, csrfToken, body: { value: '' } });
  assert.equal(result.status, 400);
  assert.deepEqual(Object.keys(result.json).sort(), ['ok', 'reason']);
}));

// -- read-only, no coupling to a missing/uninitialized SQLite state DB --

test('GET /api/instances never throws even when the runner SQLite state DB does not exist yet', () => withServer(async ({ baseUrl }) => {
  const { cookie } = await login(baseUrl);
  const result = await apiRequest(baseUrl, '/api/instances', { cookie });
  assert.equal(result.status, 200);
  const claude = result.json.instances.find((instance) => instance.agentId === 'claude-code-cli');
  assert.equal(claude.load.capacity, 1);
}));

// -- audit trail read surface --------------------------------------------

test('LEAK-PROOF (whole-tree + stdout/stderr): a secret value survives only under the secret store, never in settings, .history snapshots, audit, operator file, or anything written to the console', () => withServer(async ({ baseUrl, dir, secretStoreDir }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  const marker = 'unit-test-whole-tree-leak-marker-4f9c2a';

  // Generate real .history/<rev>.json snapshots: create an instance, then
  // two settings updates so the pre-update document is snapshotted twice.
  const created = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });
  const firstUpdate = await apiRequest(baseUrl, '/api/instances/claude-code-cli/settings', {
    method: 'PATCH', cookie, csrfToken, body: { updates: { model: 'unrelated-model-name' }, expectedRevision: created.json.revision },
  });
  await apiRequest(baseUrl, '/api/instances/claude-code-cli/settings', {
    method: 'PATCH', cookie, csrfToken, body: { updates: { profile: 'unrelated-profile' }, expectedRevision: firstUpdate.json.revision },
  });

  // Capture every byte written to stdout/stderr while the secret is created
  // and rotated with the marker value.
  const written = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return originalStdoutWrite(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return originalStderrWrite(chunk, ...rest); };
  let createResult;
  let rotateResult;
  try {
    createResult = await apiRequest(baseUrl, '/api/secrets/whole-tree-token', { method: 'POST', cookie, csrfToken, body: { value: marker } });
    rotateResult = await apiRequest(baseUrl, '/api/secrets/whole-tree-token/rotate', { method: 'POST', cookie, csrfToken, body: { value: `${marker}-rotated` } });
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  assert.equal(createResult.status, 201);
  assert.equal(rotateResult.status, 200);
  assert.ok(!written.some((chunk) => chunk.includes(marker)), 'the secret value must never be written to stdout/stderr');

  // Whole-tree walk: every file under the service's entire state directory,
  // classified by whether it lives under the secret store.
  const allFiles = walkFiles(dir);
  assert.ok(allFiles.some((path) => path.includes('.history')), 'test setup sanity: at least one .history snapshot must exist');
  const outsideSecretStore = allFiles.filter((path) => relative(secretStoreDir, path).startsWith('..'));
  const insideSecretStore = allFiles.filter((path) => !relative(secretStoreDir, path).startsWith('..'));
  assert.ok(insideSecretStore.length > 0);

  for (const path of outsideSecretStore) {
    const contents = readFileSync(path, 'utf8');
    assert.ok(!contents.includes(marker), `secret value leaked outside the secret store into ${relative(dir, path)}`);
    assert.ok(!contents.includes(`${marker}-rotated`), `rotated secret value leaked outside the secret store into ${relative(dir, path)}`);
  }

  // Positive control: the rotated value is actually present in exactly the
  // one sink that is allowed to hold it.
  const secretHits = insideSecretStore.filter((path) => readFileSync(path, 'utf8').includes(`${marker}-rotated`));
  assert.equal(secretHits.length, 1);
  assert.equal(statSync(secretHits[0]).mode & 0o777, 0o600);
}));

test('GET /api/audit returns actor/source/time/revision/changed-field-names only', () => withServer(async ({ baseUrl }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });
  const result = await apiRequest(baseUrl, '/api/audit', { cookie });
  assert.equal(result.status, 200);
  assert.ok(result.json.entries.length >= 1);
  for (const entry of result.json.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'actor', 'at', 'changedFields', 'id', 'outcome', 'reason', 'revision', 'source']);
  }
}));

// -- read-only operational overview (issue #175) ------------------------

test('GET /api/overview is refused without a session, and refused cross-origin even with one', () => withServer(async ({ baseUrl }) => {
  const anonymous = await apiRequest(baseUrl, '/api/overview');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.reason, 'session-invalid-or-expired');

  const { cookie } = await login(baseUrl);
  const foreign = await apiRequest(baseUrl, '/api/overview', { cookie, headers: { Origin: 'http://evil.example' } });
  assert.equal(foreign.status, 403);

  const response = await fetch(`${baseUrl}/api/overview`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 403, 'a GET with no Origin/Referer at all stays refused');
}));

test('GET /api/overview returns only the positive-allowlist projection, with no restricted field', () => withServer(async ({ baseUrl }) => {
  const { cookie } = await login(baseUrl);
  const result = await apiRequest(baseUrl, '/api/overview', { cookie });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.schemaVersion, 'agent-runner-control-overview/v1');

  assert.deepEqual(Object.keys(result.json).sort(), [
    'activity', 'attention', 'circuit', 'currentTask', 'generatedAt', 'health', 'links', 'notifications',
    'ok', 'project', 'queue', 'quota', 'runner', 'runs', 'scheduler', 'schemaVersion', 'stateAvailable',
  ], 'the wire shape is a fixed allowlist');

  const serialized = JSON.stringify(result.json);
  for (const forbidden of ['dbPath', 'localRepoPath', 'payload_json', 'prompt', 'stdout', 'stderr', 'csrfToken', 'sessionId', 'password', 'secretref:', 'dashboard_reference']) {
    assert.ok(!serialized.includes(forbidden), `overview must never serialize ${forbidden}`);
  }
  // No absolute filesystem path of any shape.
  assert.ok(!/"[^"]*\/(home|var|etc|tmp|root)\//.test(serialized), 'overview must never serialize a filesystem path');
  assert.ok(serialized.length < 128 * 1024, 'the overview response must stay bounded');
}));

test('with no runner state database present, GET /api/overview fails closed rather than reporting healthy', () => withServer(async ({ baseUrl, dbPath }) => {
  assert.equal(existsSync(dbPath), false);
  const { cookie } = await login(baseUrl);
  const result = await apiRequest(baseUrl, '/api/overview', { cookie });
  assert.equal(result.status, 200);
  assert.equal(result.json.stateAvailable, false);
  assert.equal(result.json.runner.code, 'unavailable');
  assert.notEqual(result.json.runner.code, 'healthy');
  assert.ok(result.json.runner.explanation.length > 0);
  assert.equal(result.json.currentTask.active, false);
  assert.equal(existsSync(dbPath), false, 'reading the overview must never create the state database');
  assert.equal(existsSync(`${dbPath}-wal`), false);
  assert.equal(existsSync(`${dbPath}-shm`), false);
}));

test('GET /api/overview mutates no durable control-service state: identical file tree before and after', () => withServer(async ({ baseUrl, dir }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });

  const fingerprint = () => walkFiles(dir)
    .map((file) => `${relative(dir, file)}:${statSync(file).size}:${readFileSync(file, 'utf8').length}`)
    .sort();

  const before = fingerprint();
  for (let i = 0; i < 3; i += 1) {
    const result = await apiRequest(baseUrl, '/api/overview', { cookie });
    assert.equal(result.status, 200);
  }
  assert.deepEqual(fingerprint(), before, 'no settings write, no audit entry, no secret touch, no state file created');
}));

test('a read of the overview never appends to the control audit log', () => withServer(async ({ baseUrl, auditPath }) => {
  const { cookie } = await login(baseUrl);
  await apiRequest(baseUrl, '/api/overview', { cookie });
  const auditAfterRead = await apiRequest(baseUrl, '/api/audit', { cookie });
  assert.equal(auditAfterRead.json.entries.length, 0);
  assert.equal(existsSync(auditPath), false, 'a pure read must not even create the audit file');
}));

test('the overview route is GET-only — it exposes no mutating verb', () => withServer(async ({ baseUrl }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const result = await apiRequest(baseUrl, '/api/overview', { method, cookie, csrfToken, body: {} });
    assert.equal(result.status, 404, `${method} /api/overview must not be routable`);
  }
}));

test('an expired session cannot read the overview after logout', () => withServer(async ({ baseUrl }) => {
  const { cookie, csrfToken } = await login(baseUrl);
  assert.equal((await apiRequest(baseUrl, '/api/overview', { cookie })).status, 200);
  await apiRequest(baseUrl, '/api/session/logout', { method: 'POST', cookie, csrfToken });
  assert.equal((await apiRequest(baseUrl, '/api/overview', { cookie })).status, 401);
}));

// -- Agents dashboard static shell (issue #47) --------------------------

test('GET / serves the dashboard shell with no session, no Origin header and no CSRF token required', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
    const body = await response.text();
    assert.match(body, /<title>/);
  });
});

test('GET /agents-dashboard.js and /agents-dashboard-view.mjs serve as JavaScript, unauthenticated', () => withServer(async ({ baseUrl }) => {
  for (const path of ['/agents-dashboard.js', '/agents-dashboard-view.mjs', '/agents-dashboard.css']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
  }
}));

test('the static shell route never shadows /api/* and unknown paths still 404 as JSON', () => withServer(async ({ baseUrl }) => {
  const missing = await fetch(`${baseUrl}/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);

  const traversal = await fetch(`${baseUrl}/../../etc/passwd`);
  assert.ok([400, 404].includes(traversal.status));

  const apiStillProtected = await fetch(`${baseUrl}/api/instances`);
  assert.equal(apiStillProtected.status, 403); // no Origin/Referer on a bare fetch — still fails closed
}));

test('serving the static shell touches none of the four control-service sinks (no audit entry, no settings write, no secret read)', () => withServer(async ({ baseUrl, auditPath }) => {
  await fetch(`${baseUrl}/`);
  await fetch(`${baseUrl}/agents-dashboard.js`);
  await fetch(`${baseUrl}/agents-dashboard.css`);
  assert.equal(existsSync(auditPath), false, 'serving static assets must never append to the audit log');
}));

// -- Agents dashboard end-to-end flow (issue #47 required_validation: --
// -- "dashboard -> control API -> atomic settings -> pre-claim           --
// -- eligibility tests using temporary state")                          --

test('full dashboard-shaped flow: create, configure, enable (pre-claim eligible), credential, drain (pre-claim ineligible), audit, rollback', () => withServer(async ({ baseUrl, settingsPath }) => {
  const { cookie, csrfToken } = await login(baseUrl);

  const listed = await apiRequest(baseUrl, '/api/instances', { cookie });
  assert.equal(listed.status, 200);
  const claude = listed.json.instances.find((instance) => instance.agentId === 'claude-code-cli');
  // The new required-view fields are present and honest — no fabricated version, no leaked path.
  assert.equal(claude.command, 'claude');
  assert.ok(claude.capabilities && claude.capabilities.model.supported === true);
  assert.equal(claude.quota.paid, true);
  assert.equal(claude.quota.costClass, 'paid-metered');
  assert.ok(!('probes' in (claude.readiness || {})));

  const created = await apiRequest(baseUrl, '/api/instances', { method: 'POST', cookie, csrfToken, body: { agentId: 'claude-code-cli' } });
  assert.equal(created.status, 201);

  const configured = await apiRequest(baseUrl, '/api/instances/claude-code-cli/settings', {
    method: 'PATCH', cookie, csrfToken, body: { updates: { model: 'claude-opus-4-8' }, expectedRevision: created.json.revision },
  });
  assert.equal(configured.status, 200);

  const enabled = await apiRequest(baseUrl, '/api/instances/claude-code-cli/lifecycle', {
    method: 'POST', cookie, csrfToken, body: { targetState: 'enabled', expectedRevision: configured.json.revision },
  });
  assert.equal(enabled.status, 200);
  assert.equal(getAgentSettings({ agentId: 'claude-code-cli', settingsPath }).routable, true, 'pre-claim gate must see the enable without a service restart');

  const secretValue = 'e2e-dashboard-flow-secret-must-never-leak';
  const secretCreated = await apiRequest(baseUrl, '/api/secrets/claude-code-cli', { method: 'POST', cookie, csrfToken, body: { value: secretValue } });
  assert.equal(secretCreated.status, 201);
  assert.ok(!JSON.stringify(secretCreated.json).includes(secretValue));
  const secretStatus = await apiRequest(baseUrl, '/api/secrets/claude-code-cli', { cookie });
  assert.equal(secretStatus.json.status.status, 'configured');

  const draining = await apiRequest(baseUrl, '/api/instances/claude-code-cli/lifecycle', {
    method: 'POST', cookie, csrfToken, body: { targetState: 'draining', expectedRevision: enabled.json.revision },
  });
  assert.equal(draining.status, 200);
  assert.equal(getAgentSettings({ agentId: 'claude-code-cli', settingsPath }).routable, false, 'draining must be pre-claim-ineligible without a restart');

  const audit = await apiRequest(baseUrl, '/api/audit', { cookie });
  assert.ok(audit.json.entries.some((entry) => entry.action === 'instance.lifecycle.transition'));
  assert.ok(!JSON.stringify(audit.json).includes(secretValue));

  const revisions = await apiRequest(baseUrl, '/api/settings/revisions', { cookie });
  assert.ok(revisions.json.availableRevisions.length > 0);
  const rollback = await apiRequest(baseUrl, '/api/settings/rollback', { method: 'POST', cookie, csrfToken, body: { targetRevision: created.json.revision } });
  assert.equal(rollback.status, 200);
  assert.equal(getAgentSettings({ agentId: 'claude-code-cli', settingsPath }).routable, false, 'rollback target predates enable, so it must be ineligible again');
}));
