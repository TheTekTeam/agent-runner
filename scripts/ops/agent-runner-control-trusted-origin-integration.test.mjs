import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { setOperatorCredential } from './agent-runner-control-auth.mjs';
import { resolveTrustedProxyOriginPath, setTrustedProxyOrigin } from './agent-runner-control-trusted-origin.mjs';

const OPERATOR = { username: 'operator', password: 'trusted-origin-integration-password' };
const TRUSTED_ORIGIN = 'https://dev-cluster-dell.tail702af6.ts.net:9443';

function waitForLine(stream) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    const timer = setTimeout(() => rejectPromise(new Error('child server did not report a port')), 5000);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        clearTimeout(timer);
        resolvePromise(buffer.slice(0, newline).trim());
      }
    });
    stream.on('error', rejectPromise);
  });
}

async function request(baseUrl, path, { method = 'GET', cookie, csrfToken, body } = {}) {
  const headers = { Origin: TRUSTED_ORIGIN };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('configured trusted HTTPS origin works through login, authenticated GET and CSRF-protected logout', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-runner-trusted-origin-http-'));
  const stateDir = join(home, 'state');
  mkdirSync(stateDir, { recursive: true });
  const operatorCredentialPath = join(stateDir, 'operator.json');
  const auditPath = join(stateDir, 'audit.jsonl');
  const settingsPath = join(stateDir, 'settings.json');
  const secretStoreDir = join(stateDir, 'secrets');
  const dbPath = join(stateDir, 'runner-state.sqlite');
  writeFileSync(auditPath, '', { mode: 0o600 });
  setOperatorCredential({ ...OPERATOR, path: operatorCredentialPath });
  setTrustedProxyOrigin({ origin: TRUSTED_ORIGIN, path: resolveTrustedProxyOriginPath({ HOME: home }) });

  const serverModule = pathToFileURL(resolve('scripts/ops/agent-runner-control-server.mjs')).href;
  const childSource = `
    const { createControlServer, listenControlServer } = await import(${JSON.stringify(serverModule)});
    const server = createControlServer({
      settingsPath: process.env.TEST_SETTINGS,
      secretStoreDir: process.env.TEST_SECRETS,
      operatorCredentialPath: process.env.TEST_OPERATOR,
      auditPath: process.env.TEST_AUDIT,
      dbPath: process.env.TEST_DB,
    });
    await listenControlServer(server, { port: 0 });
    process.stdout.write(String(server.address().port) + '\\n');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    setInterval(() => {}, 1000);
  `;

  const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      TEST_SETTINGS: settingsPath,
      TEST_SECRETS: secretStoreDir,
      TEST_OPERATOR: operatorCredentialPath,
      TEST_AUDIT: auditPath,
      TEST_DB: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const portLine = await waitForLine(child.stdout);
    const port = Number(portLine);
    assert.ok(Number.isInteger(port) && port > 0);
    const baseUrl = `http://127.0.0.1:${port}`;

    const login = await request(baseUrl, '/api/session/login', { method: 'POST', body: OPERATOR });
    assert.equal(login.status, 200);
    const loginJson = await login.json();
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.ok(loginJson.csrfToken);

    const audit = await request(baseUrl, '/api/audit', { cookie });
    assert.equal(audit.status, 200);

    const logout = await request(baseUrl, '/api/session/logout', {
      method: 'POST',
      cookie,
      csrfToken: loginJson.csrfToken,
    });
    assert.equal(logout.status, 200);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolvePromise) => child.once('exit', resolvePromise));
    rmSync(home, { recursive: true, force: true });
  }
});
