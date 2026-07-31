import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  EventIngressStore,
  GitHubWebhookIngressError,
  acceptGitHubWebhook,
} from './agent-runner-event-ingress.mjs';
import { loadProjectRegistry, resolveProjectRegistryPath } from './agent-runner-project-registry.mjs';

export const EVENT_TRANSPORT_SCHEMA_VERSION = 1;
export const DEFAULT_EVENT_TRANSPORT_PORT = 8787;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
export const MAX_SECRET_BYTES = 4096;

const REQUIRED_GITHUB_HEADERS = Object.freeze([
  'x-github-delivery',
  'x-github-event',
  'x-hub-signature-256',
]);

export class EventTransportError extends Error {
  constructor(code, statusCode = 500) {
    super(code);
    this.name = 'EventTransportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function boundedInteger(value, fallback, { name, min, max }) {
  const resolved = value ?? fallback;
  const parsed = typeof resolved === 'string' && /^\d+$/.test(resolved) ? Number(resolved) : resolved;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new EventTransportError(`invalid-${name}`);
  }
  return parsed;
}

function takeOption(argv, name) {
  let value = null;
  const remaining = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new EventTransportError(`missing-${name.slice(2)}`, 400);
      value = next;
      index += 1;
    } else if (arg.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
    } else {
      remaining.push(arg);
    }
  }
  return { value, remaining };
}

export function parseEventTransportOptions(argv = process.argv.slice(2), env = process.env) {
  const registryPath = resolveProjectRegistryPath(argv, env);
  const registry = takeOption(argv, '--project-registry');
  const db = takeOption(registry.remaining, '--db');
  const secret = takeOption(db.remaining, '--secret-file');
  const fd = takeOption(secret.remaining, '--listen-fd');
  const maxBody = takeOption(fd.remaining, '--max-body-bytes');
  const requestTimeout = takeOption(maxBody.remaining, '--request-timeout-ms');
  const headersTimeout = takeOption(requestTimeout.remaining, '--headers-timeout-ms');
  const remaining = headersTimeout.remaining.filter((arg) => arg !== '--help');
  if (remaining.length > 0) throw new EventTransportError('unknown-argument', 400);
  if (!registryPath) throw new EventTransportError('project-registry-required', 500);
  const dbPath = db.value ?? env.AGENT_RUNNER_CONTROLLER_DB;
  const secretFile = secret.value ?? env.AGENT_RUNNER_GITHUB_WEBHOOK_SECRET_FILE;
  if (!dbPath) throw new EventTransportError('controller-db-required', 500);
  if (!secretFile) throw new EventTransportError('secret-file-required', 500);
  return Object.freeze({
    registryPath: resolve(registryPath),
    dbPath: resolve(dbPath),
    secretFile: resolve(secretFile),
    listenFd: boundedInteger(fd.value ?? env.LISTEN_FDS_START ?? 3, 3, {
      name: 'listen-fd', min: 3, max: 64,
    }),
    maxBodyBytes: boundedInteger(maxBody.value ?? env.AGENT_RUNNER_WEBHOOK_MAX_BODY_BYTES, DEFAULT_WEBHOOK_MAX_BODY_BYTES, {
      name: 'max-body-bytes', min: 1024, max: DEFAULT_WEBHOOK_MAX_BODY_BYTES,
    }),
    requestTimeoutMs: boundedInteger(requestTimeout.value, DEFAULT_REQUEST_TIMEOUT_MS, {
      name: 'request-timeout-ms', min: 1000, max: 60_000,
    }),
    headersTimeoutMs: boundedInteger(headersTimeout.value, DEFAULT_HEADERS_TIMEOUT_MS, {
      name: 'headers-timeout-ms', min: 1000, max: 60_000,
    }),
  });
}

export function loadWebhookSecret(secretFile, {
  readFile = readFileSync,
  stat = statSync,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const metadata = stat(secretFile);
  if (!metadata.isFile()) throw new EventTransportError('secret-not-regular-file');
  if ((metadata.mode & 0o077) !== 0) throw new EventTransportError('secret-permissions-too-open');
  if (uid !== null && metadata.uid !== uid) throw new EventTransportError('secret-owner-mismatch');
  const bytes = readFile(secretFile);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_SECRET_BYTES) {
    throw new EventTransportError('secret-size-invalid');
  }
  let secret = bytes.toString('utf8');
  secret = secret.replace(/\r?\n$/, '');
  if (secret.includes('\n') || secret.includes('\r') || secret.includes('\0')) {
    throw new EventTransportError('secret-format-invalid');
  }
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new EventTransportError('secret-too-short');
  return secret;
}

function rawHeaderCount(request, expectedName) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (String(request.rawHeaders[index]).toLowerCase() === expectedName) count += 1;
  }
  return count;
}

export function selectGitHubHeaders(request) {
  const headers = {};
  for (const name of REQUIRED_GITHUB_HEADERS) {
    if (rawHeaderCount(request, name) !== 1) throw new EventTransportError('invalid-github-headers', 400);
    const value = request.headers[name];
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
      throw new EventTransportError('invalid-github-headers', 400);
    }
    headers[name] = value;
  }
  return Object.freeze(headers);
}

export function validateInheritedLoopbackAddress(address) {
  if (!address || typeof address === 'string') throw new EventTransportError('inherited-socket-not-tcp');
  const host = String(address.address ?? '').toLowerCase();
  if (host !== '127.0.0.1' && host !== '::ffff:127.0.0.1') {
    throw new EventTransportError('inherited-socket-not-loopback');
  }
  if (!Number.isInteger(address.port) || address.port < 1024 || address.port > 65535) {
    throw new EventTransportError('inherited-socket-port-invalid');
  }
  return true;
}

function safePath(request) {
  let parsed;
  try {
    parsed = new URL(request.url ?? '/', 'http://127.0.0.1');
  } catch {
    throw new EventTransportError('invalid-request-target', 400);
  }
  if (parsed.search || parsed.hash) throw new EventTransportError('invalid-request-target', 400);
  return parsed.pathname;
}

function writeJson(response, statusCode, value, extraHeaders = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

export function readBoundedRequestBody(request, {
  maxBodyBytes = DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  return new Promise((resolveBody, rejectBody) => {
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined) {
      if (!/^\d+$/.test(contentLength)) {
        rejectBody(new EventTransportError('invalid-content-length', 400));
        request.resume();
        return;
      }
      if (Number(contentLength) > maxBodyBytes) {
        rejectBody(new EventTransportError('payload-too-large', 413));
        request.resume();
        return;
      }
    }

    const chunks = [];
    let length = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectBody(new EventTransportError('request-timeout', 408));
      request.destroy();
    }, timeoutMs);
    timer.unref?.();

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    request.on('data', (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > maxBodyBytes) {
        finish(rejectBody, new EventTransportError('payload-too-large', 413));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish(resolveBody, Buffer.concat(chunks, length)));
    request.on('aborted', () => finish(rejectBody, new EventTransportError('request-aborted', 400)));
    request.on('error', () => finish(rejectBody, new EventTransportError('request-read-failed', 400)));
  });
}

function publicError(error) {
  if (error instanceof GitHubWebhookIngressError || error instanceof EventTransportError) {
    return { statusCode: error.statusCode ?? 500, code: error.code };
  }
  return { statusCode: 500, code: 'event-transport-failed' };
}

export function createEventTransportServer({
  registry,
  store,
  secret,
  maxBodyBytes = DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  acceptWebhook = acceptGitHubWebhook,
} = {}) {
  if (!registry?.projectsByRepository) throw new EventTransportError('validated-registry-required');
  if (!store || typeof store.recordDelivery !== 'function') throw new EventTransportError('ingress-store-required');
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new EventTransportError('secret-invalid');
  }

  const server = createServer(async (request, response) => {
    try {
      const pathname = safePath(request);
      if (pathname === '/healthz') {
        if (request.method !== 'GET') {
          writeJson(response, 405, { error: 'method-not-allowed', code: 'method-not-allowed' }, { allow: 'GET' });
          return;
        }
        writeJson(response, 200, { status: 'ok', schemaVersion: EVENT_TRANSPORT_SCHEMA_VERSION });
        return;
      }
      if (pathname !== '/github/webhook') {
        writeJson(response, 404, { error: 'not-found', code: 'not-found' });
        return;
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method-not-allowed', code: 'method-not-allowed' }, { allow: 'POST' });
        return;
      }
      const headers = selectGitHubHeaders(request);
      const rawBody = await readBoundedRequestBody(request, { maxBodyBytes, timeoutMs: requestTimeoutMs });
      const result = acceptWebhook({ rawBody, headers, secret, registry, store, maxBodyBytes });
      const duplicate = result.status === 'duplicate';
      writeJson(response, duplicate ? 200 : 202, { status: duplicate ? 'duplicate' : 'accepted' });
    } catch (error) {
      const failure = publicError(error);
      writeJson(response, failure.statusCode, { error: 'webhook-rejected', code: failure.code });
    }
  });
  server.requestTimeout = requestTimeoutMs;
  return server;
}

export async function startEventTransport({
  options,
  registry = loadProjectRegistry({ registryPath: options.registryPath }),
  secret = loadWebhookSecret(options.secretFile),
  store = new EventIngressStore(options.dbPath),
} = {}) {
  const server = createEventTransportServer({
    registry,
    store,
    secret,
    maxBodyBytes: options.maxBodyBytes,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  server.headersTimeout = options.headersTimeoutMs;

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen({ fd: options.listenFd }, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    validateInheritedLoopbackAddress(server.address());
  } catch (error) {
    store.close();
    try { server.close(); } catch { /* best effort */ }
    throw error;
  }

  const close = async () => {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    store.close();
  };
  return Object.freeze({ server, close });
}

function helpText() {
  return [
    'Usage: node scripts/ops/agent-runner-event-transport.mjs --project-registry <path> --db <path> --secret-file <path> --listen-fd 3',
    '',
    'This service accepts only a systemd-inherited loopback TCP socket.',
    'Routes: GET /healthz and POST /github/webhook.',
  ].join('\n');
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  if (process.argv.includes('--help')) {
    process.stdout.write(`${helpText()}\n`);
  } else {
    let runtime = null;
    const shutdown = async () => {
      if (!runtime) return;
      const active = runtime;
      runtime = null;
      await active.close();
    };
    Promise.resolve()
      .then(() => parseEventTransportOptions())
      .then((options) => startEventTransport({ options }))
      .then((started) => {
        runtime = started;
        process.stdout.write(`${JSON.stringify({ status: 'listening', schemaVersion: EVENT_TRANSPORT_SCHEMA_VERSION })}\n`);
        process.once('SIGTERM', () => shutdown().finally(() => { process.exitCode = 0; }));
        process.once('SIGINT', () => shutdown().finally(() => { process.exitCode = 0; }));
      })
      .catch((error) => {
        const failure = publicError(error);
        process.stderr.write(`${JSON.stringify({ ok: false, code: failure.code })}\n`);
        process.exitCode = 1;
      });
  }
}
