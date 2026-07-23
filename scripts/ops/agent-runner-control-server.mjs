#!/usr/bin/env node
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { AGENT_ADAPTERS } from './agent-runner-agents.mjs';
import { resolveAgentSettingsPath } from './agent-runner-agent-settings.mjs';
import { appendControlAuditEntry, readControlAuditEntries, resolveControlAuditPath } from './agent-runner-control-audit.mjs';
import {
  buildSessionClearCookie,
  buildSessionCookie,
  createControlSessionStore,
  parseSessionCookie,
  resolveOperatorCredentialPath,
  verifyOperatorCredential,
} from './agent-runner-control-auth.mjs';
import { CSRF_HEADER_NAME, validateCsrfToken, validateOrigin } from './agent-runner-control-csrf.mjs';
import {
  createInstance,
  getInstanceSnapshot,
  InstanceAdapterNotApprovedError,
  InstanceAlreadyExistsError,
  InstanceNotFoundError,
  InstanceUpdateRejectedError,
  listInstanceSnapshots,
  transitionInstanceLifecycle,
  updateInstanceSettings,
} from './agent-runner-control-instances.mjs';
import { computeInstanceLoad, computeInstanceReadiness } from './agent-runner-control-readiness.mjs';
import {
  ControlSettingsInvalidDocumentError,
  ControlSettingsLockedError,
  ControlSettingsRollbackUnavailableError,
  ControlSettingsStaleRevisionError,
  listControlSettingsHistory,
  loadControlSettingsDocument,
  rollbackControlSettings,
} from './agent-runner-control-settings-store.mjs';
import {
  createSecret,
  getSecretStatus,
  removeSecret,
  resolveSecretStoreDir,
  rotateSecret,
  SecretActiveError,
  SecretLockedError,
  validateSecretId,
} from './agent-runner-secret-store.mjs';

/**
 * Loopback-bound authenticated machine-local control service (issue #46).
 *
 * Every request handler in this file only ever touches four sinks: the
 * control settings document (metadata + `secretref:`-shaped strings only,
 * never a secret value), the #45 protected secret store (values, write-only
 * — nothing here ever reads a value back out), the control audit log
 * (actor/source/time/revision/changed-field-*names* only), and the
 * operator-credential verifier (hash comparison only). Nothing in this
 * module opens the runner SQLite state DB for writing, and the only SQLite
 * *read* is `computeInstanceLoad()`'s existing dashboard summary, reused
 * read-only exactly as the static dashboard already uses it.
 *
 * No route ever logs a request body. Validation-failure responses report a
 * bounded machine-readable reason code, never an echo of submitted input —
 * this is the concrete containment for "never return, log, audit, serialize,
 * display or publish a secret value".
 */

const ALLOWED_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY_BYTES = 64 * 1024;
const INSTANCE_ID_SEGMENT = '([A-Za-z0-9][A-Za-z0-9_-]{0,63})';

/** Fail closed before ever calling `server.listen()` on anything but loopback. */
export function resolveBindHost(requestedHost = '127.0.0.1') {
  const host = String(requestedHost || '127.0.0.1').trim();
  if (!ALLOWED_BIND_HOSTS.has(host)) {
    const error = new Error(`refusing to bind the control service to a non-loopback host: ${host}`);
    error.code = 'AGENT_RUNNER_CONTROL_NON_LOOPBACK_BIND_REFUSED';
    throw error;
  }
  return host;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...extraHeaders });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        rejectPromise(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(Object.assign(new Error('invalid JSON body'), { code: 'INVALID_JSON' }));
      }
    });
    req.on('error', rejectPromise);
  });
}

const ERROR_STATUS_BY_CODE = new Map([
  [InstanceAdapterNotApprovedError, 400],
  [InstanceAlreadyExistsError, 409],
  [InstanceNotFoundError, 404],
  [InstanceUpdateRejectedError, 422],
  [ControlSettingsStaleRevisionError, 409],
  [ControlSettingsLockedError, 423],
  [ControlSettingsRollbackUnavailableError, 404],
  [ControlSettingsInvalidDocumentError, 500],
  [SecretLockedError, 423],
  [SecretActiveError, 409],
]);

/**
 * Maps a known error class to a bounded `{status, reason}` response. Every
 * `reason` here is a fixed code or, at most, an identifier the caller
 * already submitted (an agent id, a secret id, a field name) — never a
 * secret value, since none of these error types can carry one.
 */
function mapErrorToResponse(error) {
  for (const [ErrorClass, status] of ERROR_STATUS_BY_CODE) {
    if (error instanceof ErrorClass) {
      return { status, body: { ok: false, reason: error.reason || error.code || error.name, field: error.field || null } };
    }
  }
  return { status: 500, body: { ok: false, reason: 'internal-error' } };
}

function sendMappedError(res, error) {
  const mapped = mapErrorToResponse(error);
  return sendJson(res, mapped.status, mapped.body);
}

function buildReadinessMap() {
  const map = {};
  for (const adapter of Object.values(AGENT_ADAPTERS)) {
    map[adapter.agentId] = computeInstanceReadiness({ adapter });
  }
  return map;
}

function normalizeExpectedRevision(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : NaN;
}

function decorateWithLoad(instance, ctx) {
  return { ...instance, load: computeInstanceLoad({ agentId: instance.agentId, env: ctx.env, dbPath: ctx.dbPath }) };
}

// -- route handlers ----------------------------------------------------

async function handleLogin(ctx) {
  const { username, password } = ctx.body || {};
  const verification = verifyOperatorCredential({ username, password, path: ctx.operatorCredentialPath });
  if (!verification.ok) return sendJson(ctx.res, 401, { ok: false, reason: verification.reason });
  const session = ctx.sessionStore.create(verification.username);
  return sendJson(
    ctx.res,
    200,
    { ok: true, csrfToken: session.csrfToken, expiresAtMs: session.expiresAtMs },
    { 'Set-Cookie': buildSessionCookie(session.id) },
  );
}

async function handleLogout(ctx) {
  ctx.sessionStore.destroy(ctx.session.id);
  return sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': buildSessionClearCookie() });
}

async function handleListInstances(ctx) {
  const instances = listInstanceSnapshots({ path: ctx.settingsPath, readinessByAgent: buildReadinessMap() })
    .map((instance) => decorateWithLoad(instance, ctx));
  return sendJson(ctx.res, 200, { ok: true, instances });
}

async function handleGetInstance(ctx) {
  const agentId = ctx.match[1];
  const readiness = buildReadinessMap()[agentId] || null;
  const instance = decorateWithLoad(getInstanceSnapshot({ path: ctx.settingsPath, agentId, readiness }), ctx);
  return sendJson(ctx.res, 200, { ok: true, instance });
}

async function handleCreateInstance(ctx) {
  const { agentId, initialFields, expectedRevision } = ctx.body || {};
  if (typeof agentId !== 'string' || !agentId) return sendJson(ctx.res, 400, { ok: false, reason: 'agent-id-required' });
  const revision = normalizeExpectedRevision(expectedRevision);
  if (Number.isNaN(revision)) return sendJson(ctx.res, 400, { ok: false, reason: 'expected-revision-invalid' });
  try {
    const result = createInstance({
      path: ctx.settingsPath,
      auditPath: ctx.auditPath,
      agentId,
      initialFields,
      expectedRevision: revision,
      actor: ctx.actor,
      source: ctx.source,
    });
    return sendJson(ctx.res, 201, { ok: true, revision: result.revision, instance: decorateWithLoad(result.snapshot, ctx) });
  } catch (error) {
    return sendMappedError(ctx.res, error);
  }
}

async function handleUpdateInstanceSettings(ctx) {
  const agentId = ctx.match[1];
  const { updates, expectedRevision } = ctx.body || {};
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
    return sendJson(ctx.res, 400, { ok: false, reason: 'updates-required' });
  }
  const revision = normalizeExpectedRevision(expectedRevision);
  if (Number.isNaN(revision)) return sendJson(ctx.res, 400, { ok: false, reason: 'expected-revision-invalid' });
  try {
    const result = updateInstanceSettings({
      path: ctx.settingsPath,
      auditPath: ctx.auditPath,
      agentId,
      updates,
      expectedRevision: revision,
      actor: ctx.actor,
      source: ctx.source,
    });
    return sendJson(ctx.res, 200, { ok: true, revision: result.revision, instance: decorateWithLoad(result.snapshot, ctx) });
  } catch (error) {
    return sendMappedError(ctx.res, error);
  }
}

async function handleTransitionLifecycle(ctx) {
  const agentId = ctx.match[1];
  const { targetState, expectedRevision } = ctx.body || {};
  if (typeof targetState !== 'string' || !targetState) return sendJson(ctx.res, 400, { ok: false, reason: 'target-state-required' });
  const revision = normalizeExpectedRevision(expectedRevision);
  if (Number.isNaN(revision)) return sendJson(ctx.res, 400, { ok: false, reason: 'expected-revision-invalid' });
  try {
    const result = transitionInstanceLifecycle({
      path: ctx.settingsPath,
      auditPath: ctx.auditPath,
      agentId,
      targetState,
      expectedRevision: revision,
      actor: ctx.actor,
      source: ctx.source,
    });
    return sendJson(ctx.res, 200, { ok: true, revision: result.revision, instance: decorateWithLoad(result.snapshot, ctx) });
  } catch (error) {
    return sendMappedError(ctx.res, error);
  }
}

async function handleListRevisions(ctx) {
  const { doc } = loadControlSettingsDocument(ctx.settingsPath);
  const availableRevisions = listControlSettingsHistory(ctx.settingsPath);
  return sendJson(ctx.res, 200, { ok: true, currentRevision: doc.revision, availableRevisions });
}

async function handleRollback(ctx) {
  const targetRevision = normalizeExpectedRevision(ctx.body?.targetRevision);
  if (targetRevision === null || Number.isNaN(targetRevision)) {
    return sendJson(ctx.res, 400, { ok: false, reason: 'target-revision-required' });
  }
  try {
    const result = rollbackControlSettings({ path: ctx.settingsPath, targetRevision });
    appendControlAuditEntry({
      actor: ctx.actor,
      source: ctx.source,
      action: 'settings.rollback',
      revision: result.revision,
      changedFields: ['agents'],
      path: ctx.auditPath,
    });
    return sendJson(ctx.res, 200, { ok: true, revision: result.revision, restoredFromRevision: result.restoredFromRevision });
  } catch (error) {
    return sendMappedError(ctx.res, error);
  }
}

async function handleAudit(ctx) {
  const limitParam = ctx.query.get('limit');
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  const entries = readControlAuditEntries({ path: ctx.auditPath, limit: Number.isInteger(limit) ? limit : 50 });
  return sendJson(ctx.res, 200, { ok: true, entries });
}

async function handleGetSecretStatus(ctx) {
  const id = ctx.match[1];
  if (!validateSecretId(id).ok) return sendJson(ctx.res, 400, { ok: false, reason: 'invalid-secret-id' });
  const status = getSecretStatus(ctx.secretStoreDir, id);
  return sendJson(ctx.res, 200, { ok: true, status });
}

/**
 * Write-only integration with #45: `value` is read from the parsed body and
 * handed directly to `createSecret`/`rotateSecret`. It is never assigned to
 * any variable that is logged, audited, or included in the response — the
 * response and the audit entry below carry only `id`/`status`/field names.
 */
async function handleCreateSecret(ctx) {
  const id = ctx.match[1];
  if (!validateSecretId(id).ok) return sendJson(ctx.res, 400, { ok: false, reason: 'invalid-secret-id' });
  const { value } = ctx.body || {};
  if (typeof value !== 'string' || value.length === 0) return sendJson(ctx.res, 400, { ok: false, reason: 'secret-value-required' });
  try {
    const result = createSecret(ctx.secretStoreDir, id, value);
    appendControlAuditEntry({ actor: ctx.actor, source: ctx.source, action: 'secret.create', changedFields: [`secrets.${id}`], path: ctx.auditPath });
    return sendJson(ctx.res, 201, { ok: true, id: result.id, status: result.status });
  } catch (error) {
    if (error?.code === 'AGENT_RUNNER_SECRET_ALREADY_EXISTS') return sendJson(ctx.res, 409, { ok: false, reason: 'secret-already-exists' });
    return sendJson(ctx.res, 400, { ok: false, reason: 'secret-create-failed' });
  }
}

async function handleRotateSecret(ctx) {
  const id = ctx.match[1];
  if (!validateSecretId(id).ok) return sendJson(ctx.res, 400, { ok: false, reason: 'invalid-secret-id' });
  const { value } = ctx.body || {};
  if (typeof value !== 'string' || value.length === 0) return sendJson(ctx.res, 400, { ok: false, reason: 'secret-value-required' });
  try {
    const result = rotateSecret(ctx.secretStoreDir, id, value);
    appendControlAuditEntry({ actor: ctx.actor, source: ctx.source, action: 'secret.rotate', changedFields: [`secrets.${id}`], path: ctx.auditPath });
    return sendJson(ctx.res, 200, { ok: true, id: result.id, status: result.status });
  } catch (error) {
    if (error?.code === 'AGENT_RUNNER_SECRET_NOT_FOUND') return sendJson(ctx.res, 404, { ok: false, reason: 'secret-not-found' });
    return sendJson(ctx.res, 400, { ok: false, reason: 'secret-rotate-failed' });
  }
}

async function handleRemoveSecret(ctx) {
  const id = ctx.match[1];
  if (!validateSecretId(id).ok) return sendJson(ctx.res, 400, { ok: false, reason: 'invalid-secret-id' });
  try {
    const result = removeSecret(ctx.secretStoreDir, id);
    appendControlAuditEntry({ actor: ctx.actor, source: ctx.source, action: 'secret.remove', changedFields: [`secrets.${id}`], path: ctx.auditPath });
    return sendJson(ctx.res, 200, { ok: true, id: result.id, status: result.status });
  } catch (error) {
    return sendMappedError(ctx.res, error);
  }
}

const ROUTES = [
  { method: 'POST', pattern: /^\/api\/session\/login$/, handler: handleLogin, requiresAuth: false, mutating: true },
  { method: 'POST', pattern: /^\/api\/session\/logout$/, handler: handleLogout, requiresAuth: true, mutating: true },
  { method: 'GET', pattern: /^\/api\/instances$/, handler: handleListInstances, requiresAuth: true, mutating: false },
  { method: 'GET', pattern: new RegExp(`^/api/instances/${INSTANCE_ID_SEGMENT}$`), handler: handleGetInstance, requiresAuth: true, mutating: false },
  { method: 'POST', pattern: /^\/api\/instances$/, handler: handleCreateInstance, requiresAuth: true, mutating: true },
  { method: 'PATCH', pattern: new RegExp(`^/api/instances/${INSTANCE_ID_SEGMENT}/settings$`), handler: handleUpdateInstanceSettings, requiresAuth: true, mutating: true },
  { method: 'POST', pattern: new RegExp(`^/api/instances/${INSTANCE_ID_SEGMENT}/lifecycle$`), handler: handleTransitionLifecycle, requiresAuth: true, mutating: true },
  { method: 'GET', pattern: /^\/api\/settings\/revisions$/, handler: handleListRevisions, requiresAuth: true, mutating: false },
  { method: 'POST', pattern: /^\/api\/settings\/rollback$/, handler: handleRollback, requiresAuth: true, mutating: true },
  { method: 'GET', pattern: /^\/api\/audit$/, handler: handleAudit, requiresAuth: true, mutating: false },
  { method: 'GET', pattern: new RegExp(`^/api/secrets/${INSTANCE_ID_SEGMENT}$`), handler: handleGetSecretStatus, requiresAuth: true, mutating: false },
  { method: 'POST', pattern: new RegExp(`^/api/secrets/${INSTANCE_ID_SEGMENT}$`), handler: handleCreateSecret, requiresAuth: true, mutating: true },
  { method: 'POST', pattern: new RegExp(`^/api/secrets/${INSTANCE_ID_SEGMENT}/rotate$`), handler: handleRotateSecret, requiresAuth: true, mutating: true },
  { method: 'DELETE', pattern: new RegExp(`^/api/secrets/${INSTANCE_ID_SEGMENT}$`), handler: handleRemoveSecret, requiresAuth: true, mutating: true },
];

function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (match) return { route, match };
  }
  return null;
}

function getAllowedOrigins(server) {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : null;
  if (!port) return [];
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

async function handleRequest(req, res, server, config) {
  let url;
  try {
    url = new URL(req.url, 'http://control.internal');
  } catch {
    return sendJson(res, 400, { ok: false, reason: 'invalid-request-target' });
  }

  const found = matchRoute(req.method, url.pathname);
  if (!found) return sendJson(res, 404, { ok: false, reason: 'not-found' });
  const { route, match } = found;

  const originCheck = validateOrigin({
    originHeader: req.headers.origin || null,
    refererHeader: req.headers.referer || null,
    allowedOrigins: getAllowedOrigins(server),
  });
  if (!originCheck.ok) return sendJson(res, 403, { ok: false, reason: originCheck.reason });

  let session = null;
  if (route.requiresAuth) {
    const sessionId = parseSessionCookie(req.headers.cookie);
    session = config.sessionStore.get(sessionId);
    if (!session) return sendJson(res, 401, { ok: false, reason: 'session-invalid-or-expired' });
  }

  if (route.mutating && route.requiresAuth) {
    const csrfCheck = validateCsrfToken({ headerToken: req.headers[CSRF_HEADER_NAME], sessionCsrfToken: session?.csrfToken });
    if (!csrfCheck.ok) return sendJson(res, 403, { ok: false, reason: csrfCheck.reason });
  }

  let body = {};
  if (route.method === 'POST' || route.method === 'PATCH') {
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { ok: false, reason: 'request-body-too-large' });
      return sendJson(res, 400, { ok: false, reason: 'invalid-json-body' });
    }
  }

  const ctx = {
    req,
    res,
    match,
    query: url.searchParams,
    session,
    body,
    settingsPath: config.settingsPath,
    secretStoreDir: config.secretStoreDir,
    auditPath: config.auditPath,
    operatorCredentialPath: config.operatorCredentialPath,
    dbPath: config.dbPath,
    env: config.env,
    sessionStore: config.sessionStore,
    actor: session?.username || 'anonymous',
    source: 'control-api',
  };

  return route.handler(ctx);
}

/**
 * Build (but do not bind) the control service. `host` is validated by
 * `resolveBindHost()` before this returns anything that could be passed to
 * `listen()` — a caller that mistakenly requests a LAN/public host gets a
 * thrown error here, never a running server.
 */
export function createControlServer({
  env = process.env,
  host = '127.0.0.1',
  settingsPath = resolveAgentSettingsPath(env),
  secretStoreDir = resolveSecretStoreDir(env),
  operatorCredentialPath = resolveOperatorCredentialPath(env),
  auditPath = resolveControlAuditPath(env),
  dbPath,
  sessionStore = createControlSessionStore(),
} = {}) {
  const boundHost = resolveBindHost(host);
  const config = { env, settingsPath, secretStoreDir, operatorCredentialPath, auditPath, dbPath, sessionStore };
  const server = createServer((req, res) => {
    handleRequest(req, res, server, config).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, reason: 'internal-error' });
    });
  });
  server.__agentRunnerControlBindHost = boundHost;
  return server;
}

export function listenControlServer(server, { host = server.__agentRunnerControlBindHost || '127.0.0.1', port = 0 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, resolveBindHost(host), () => resolvePromise(server));
  });
}

function helpText() {
  return 'Usage: node scripts/ops/agent-runner-control-server.mjs [--host 127.0.0.1] [--port 0]\n\n'
    + 'Foundation-only manual entrypoint. Not wired into any installer, systemd unit or timer.\n'
    + 'Bootstrap an operator credential first with agent-runner-control-auth.mjs setOperatorCredential().\n';
}

export async function run(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout.write(helpText());
    return 0;
  }
  let host = '127.0.0.1';
  let port = 0;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--host') host = argv[++i];
    else if (argv[i] === '--port') port = Number.parseInt(argv[++i], 10) || 0;
  }
  const server = createControlServer({ env, host });
  await listenControlServer(server, { host, port });
  const address = server.address();
  io.stdout.write(`Agent Runner control service listening on http://${address.address}:${address.port}\n`);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
