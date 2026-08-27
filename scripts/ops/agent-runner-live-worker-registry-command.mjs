#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID,
  LiveWorkerRegistryError,
  loadLiveWorkerRegistryDocument,
  planLiveWorkerRegistryPromotion,
  promoteLiveWorkerRegistry,
  replaceLiveWorkerRegistry,
  resolveLiveWorkerRegistryPath,
  safeLiveWorkerRegistrySummary,
  transitionLiveWorkerInstance,
} from './agent-runner-live-worker-registry-store.mjs';
import {
  fetchFleetActivationComments,
  resolveFleetActivationAuthority,
  resolveFleetActivationControlIssue,
} from './agent-runner-fleet-activation-authority.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '../..');
const FULL_SHA = /^[a-f0-9]{40}$/;
const MAX_INPUT_BYTES = 128 * 1024;

function parseInteger(value, name) {
  if (!/^\d+$/.test(String(value || ''))) throw new LiveWorkerRegistryError('live-worker-registry-command-argument-invalid', `${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new LiveWorkerRegistryError('live-worker-registry-command-argument-invalid', `${name} is invalid`);
  return parsed;
}

function parseArgs(argv = []) {
  const mode = argv[0];
  if (!['inspect', 'plan', 'promote', 'replace', 'transition'].includes(mode)) {
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
    else if (flag === '--authority-comment-id') args.authorityCommentId = parseInteger(value, 'authority comment id');
    else throw new LiveWorkerRegistryError('live-worker-registry-command-argument-invalid');
  }
  if (mode !== 'inspect' && args.expectedRevision === undefined) {
    throw new LiveWorkerRegistryError('live-worker-registry-command-expected-revision-required');
  }
  if (mode === 'transition' && (!args.instanceId || !args.targetState || !args.authorityCommentId)) {
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

function readCurrentSourceHead(spawnFn = spawnSync) {
  const result = spawnFn('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const head = String(result?.stdout || '').trim().toLowerCase();
  if (result?.status !== 0 || !FULL_SHA.test(head)) {
    const error = new Error('fleet activation source head unavailable');
    error.code = 'fleet-activation-source-head-unavailable';
    throw error;
  }
  return head;
}

function safeFailure(error) {
  const candidate = String(error?.code || '');
  const code = /^[a-z0-9._:-]{1,128}$/i.test(candidate)
    ? candidate
    : 'live-worker-registry-command-failed';
  return Object.freeze({ schemaVersion: 1, ok: false, errorCode: code });
}

export function main(argv = process.argv.slice(2), {
  env = process.env,
  hostnameFn = hostname,
  readFn = readFileSync,
  writeFn = (value) => process.stdout.write(value),
  fetchCommentsFn = fetchFleetActivationComments,
  readHeadFn = readCurrentSourceHead,
} = {}) {
  try {
    const args = parseArgs(argv);
    const path = resolveLiveWorkerRegistryPath(env);
    if (args.mode === 'inspect') {
      const loaded = loadLiveWorkerRegistryDocument({ path, allowMissing: true });
      writeFn(`${JSON.stringify({ schemaVersion: 1, ok: true, registry: safeLiveWorkerRegistrySummary(loaded) })}\n`);
      return 0;
    }

    if (args.mode === 'plan') {
      const current = loadLiveWorkerRegistryDocument({ path, allowMissing: true });
      if (current.revision !== args.expectedRevision) {
        throw new LiveWorkerRegistryError(
          'live-worker-registry-stale-revision',
          `expected revision ${args.expectedRevision}, current ${current.revision}`,
        );
      }
      const raw = boundedStdin(readFn);
      const plan = planLiveWorkerRegistryPromotion({
        expectedRevision: args.expectedRevision,
        controllerNodeId: LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID,
        nodes: raw.nodes,
        runtimeInstances: raw.runtimeInstances,
        providerAccountCaps: raw.providerAccountCaps || {},
      });
      const summary = safeLiveWorkerRegistrySummary({
        found: true,
        revision: plan.targetRevision,
        registry: plan.registry,
        document: { activationAuthorities: {}, lastTransition: null },
      });
      writeFn(`${JSON.stringify({
        schemaVersion: 1,
        ok: true,
        mode: 'plan',
        expectedRevision: plan.expectedRevision,
        targetRevision: plan.targetRevision,
        publicationRevision: plan.publicationRevision,
        publicationFingerprint: plan.publicationFingerprint,
        registry: summary,
      })}\n`);
      return 0;
    }

    const controllerNodeId = assertDellControllerHost(hostnameFn);
    let loaded;
    if (args.mode === 'promote') {
      const raw = boundedStdin(readFn);
      loaded = promoteLiveWorkerRegistry({
        path,
        expectedRevision: args.expectedRevision,
        controllerNodeId,
        nodes: raw.nodes,
        runtimeInstances: raw.runtimeInstances,
        providerAccountCaps: raw.providerAccountCaps || {},
      });
    } else if (args.mode === 'replace') {
      const raw = boundedStdin(readFn);
      loaded = replaceLiveWorkerRegistry({
        path,
        expectedRevision: args.expectedRevision,
        controllerNodeId,
        registry: raw,
      });
    } else {
      const current = loadLiveWorkerRegistryDocument({ path, allowMissing: false });
      if (current.revision !== args.expectedRevision) {
        throw new LiveWorkerRegistryError(
          'live-worker-registry-stale-revision',
          `expected revision ${args.expectedRevision}, current ${current.revision}`,
        );
      }
      const controlIssue = resolveFleetActivationControlIssue(env);
      const comments = fetchCommentsFn(controlIssue, { env });
      const currentSourceCommit = readHeadFn();
      const registryWithDocumentRevision = Object.freeze({
        ...current.registry,
        documentRevision: current.revision,
      });
      const activationAuthority = resolveFleetActivationAuthority({
        comments,
        env,
        controlIssue,
        requestedCommentId: args.authorityCommentId,
        currentSourceCommit,
        registry: registryWithDocumentRevision,
        instanceId: args.instanceId,
        targetState: args.targetState,
        previousTransition: current.document?.lastTransition || null,
      });
      loaded = transitionLiveWorkerInstance({
        path,
        expectedRevision: args.expectedRevision,
        controllerNodeId,
        instanceId: args.instanceId,
        targetState: args.targetState,
        activationAuthority,
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
