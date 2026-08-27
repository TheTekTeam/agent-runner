#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import {
  LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID,
  LiveWorkerRegistryError,
  loadLiveWorkerRegistryDocument,
  replaceLiveWorkerRegistry,
  resolveLiveWorkerRegistryPath,
  safeLiveWorkerRegistrySummary,
  transitionLiveWorkerInstance,
} from './agent-runner-live-worker-registry-store.mjs';

const MAX_INPUT_BYTES = 128 * 1024;

function parseInteger(value, name) {
  if (!/^\d+$/.test(String(value || ''))) throw new LiveWorkerRegistryError('live-worker-registry-command-argument-invalid', `${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new LiveWorkerRegistryError('live-worker-registry-command-argument-invalid', `${name} is invalid`);
  return parsed;
}

function parseArgs(argv = []) {
  const mode = argv[0];
  if (!['inspect', 'replace', 'transition'].includes(mode)) {
    throw new LiveWorkerRegistryError('live-worker-registry-command-mode-invalid');
  }
  const args = { mode };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value) throw new LiveWorkerRegistryError('live-worker-registry-command-argument-invalid');
    if (flag === '--expected-revision') args.expectedRevision = parseInteger(value, 'expected revision');
    else if (flag === '--instance') args.instanceId = value;
    else if (flag === '--state') args.targetState = value;
    else if (flag === '--authority-revision') args.authorityRevision = value;
    else if (flag === '--authority-fingerprint') args.authorityFingerprint = value;
    else throw new LiveWorkerRegistryError('live-worker-registry-command-argument-invalid');
  }
  if (mode !== 'inspect' && args.expectedRevision === undefined) {
    throw new LiveWorkerRegistryError('live-worker-registry-command-expected-revision-required');
  }
  if (mode === 'transition' && (!args.instanceId || !args.targetState)) {
    throw new LiveWorkerRegistryError('live-worker-registry-command-transition-arguments-required');
  }
  return args;
}

function boundedStdin(readFn) {
  const raw = String(readFn(0, 'utf8') || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) {
    throw new LiveWorkerRegistryError('live-worker-registry-command-input-too-large');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LiveWorkerRegistryError('live-worker-registry-command-json-invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LiveWorkerRegistryError('live-worker-registry-command-json-invalid');
  }
  return parsed;
}

function assertDellControllerHost(hostnameFn) {
  const observed = String(hostnameFn() || '').trim();
  if (observed !== LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID) {
    throw new LiveWorkerRegistryError('live-worker-registry-controller-write-refused');
  }
  return observed;
}

function safeFailure(error) {
  const code = error instanceof LiveWorkerRegistryError && /^[a-z0-9._:-]{1,128}$/i.test(error.code)
    ? error.code
    : 'live-worker-registry-command-failed';
  return Object.freeze({ schemaVersion: 1, ok: false, errorCode: code });
}

export function main(argv = process.argv.slice(2), {
  env = process.env,
  hostnameFn = hostname,
  readFn = readFileSync,
  writeFn = (value) => process.stdout.write(value),
} = {}) {
  try {
    const args = parseArgs(argv);
    const path = resolveLiveWorkerRegistryPath(env);
    if (args.mode === 'inspect') {
      const loaded = loadLiveWorkerRegistryDocument({ path, allowMissing: true });
      writeFn(`${JSON.stringify({ schemaVersion: 1, ok: true, registry: safeLiveWorkerRegistrySummary(loaded) })}\n`);
      return 0;
    }

    const controllerNodeId = assertDellControllerHost(hostnameFn);
    let loaded;
    if (args.mode === 'replace') {
      const raw = boundedStdin(readFn);
      loaded = replaceLiveWorkerRegistry({
        path,
        expectedRevision: args.expectedRevision,
        controllerNodeId,
        registry: raw,
      });
    } else {
      loaded = transitionLiveWorkerInstance({
        path,
        expectedRevision: args.expectedRevision,
        controllerNodeId,
        instanceId: args.instanceId,
        targetState: args.targetState,
        authorityRevision: args.authorityRevision || null,
        authorityFingerprint: args.authorityFingerprint || null,
      });
    }
    writeFn(`${JSON.stringify({ schemaVersion: 1, ok: true, registry: safeLiveWorkerRegistrySummary(loaded) })}\n`);
    return 0;
  } catch (error) {
    writeFn(`${JSON.stringify(safeFailure(error))}\n`);
    return 1;
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href
  : false;

if (invokedAsScript) {
  process.exitCode = main();
}
