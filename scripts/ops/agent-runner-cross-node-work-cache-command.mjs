#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import {
  consumeCrossNodeCacheEnvelope,
  exportCrossNodeCacheEnvelope,
  serializeCrossNodeCacheEnvelope,
} from './agent-runner-cross-node-work-cache.mjs';
import { defaultDeterministicWorkCacheRoot } from './agent-runner-deterministic-work-cache.mjs';

export const CROSS_NODE_CACHE_COMMAND_SCHEMA_VERSION = 1;
export const CROSS_NODE_CACHE_ROOT_ENV = 'AGENT_RUNNER_CROSS_NODE_CACHE_ROOT';
export const NODE_ID_ENV = 'AGENT_RUNNER_NODE_ID';
export const NODE_CAPABILITY_ENV = 'AGENT_RUNNER_NODE_CAPABILITY_FINGERPRINT';
export const TOOLCHAIN_ENV = 'AGENT_RUNNER_TOOLCHAIN_FINGERPRINT';
export const PLATFORM_ENV = 'AGENT_RUNNER_PLATFORM_FINGERPRINT';
export const MAX_STDIN_BYTES = 256 * 1024;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function fail(errorCode) {
  return Object.freeze({ schemaVersion: CROSS_NODE_CACHE_COMMAND_SCHEMA_VERSION, ok: false, errorCode });
}

function success(payload) {
  return Object.freeze({ schemaVersion: CROSS_NODE_CACHE_COMMAND_SCHEMA_VERSION, ok: true, ...payload });
}

function exactFields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((item, index) => item === wanted[index]);
}

function machineIdentity(env = process.env) {
  const nodeId = String(env[NODE_ID_ENV] || '').trim();
  const capabilityFingerprint = String(env[NODE_CAPABILITY_ENV] || '').trim();
  const toolchainFingerprint = String(env[TOOLCHAIN_ENV] || '').trim();
  const platformFingerprint = String(env[PLATFORM_ENV] || '').trim();
  if (!TOKEN.test(nodeId)) throw new Error('machine-identity-invalid');
  for (const value of [capabilityFingerprint, toolchainFingerprint, platformFingerprint]) {
    if (!SHA256.test(value)) throw new Error('machine-identity-invalid');
  }
  return { nodeId, capabilityFingerprint, toolchainFingerprint, platformFingerprint };
}

function cacheRoot(env = process.env) {
  const configured = String(env[CROSS_NODE_CACHE_ROOT_ENV] || '').trim();
  return configured || defaultDeterministicWorkCacheRoot(env);
}

export function readBoundedStdin({ fd = 0, reader = readFileSync } = {}) {
  const value = reader(fd);
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8');
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_STDIN_BYTES) throw new Error('stdin-size-invalid');
  return buffer.toString('utf8');
}

function parseInput(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid-json');
  }
}

export function runCrossNodeCacheCommand({ mode, input, env = process.env } = {}) {
  if (!['export', 'consume'].includes(mode)) return fail('mode-invalid');
  let identity;
  try {
    identity = machineIdentity(env);
  } catch {
    return fail('machine-identity-invalid');
  }
  const root = cacheRoot(env);

  if (mode === 'export') {
    if (!exactFields(input, ['descriptor'])) return fail('input-field-set-invalid');
    try {
      const exported = exportCrossNodeCacheEnvelope({
        root,
        descriptor: input.descriptor,
        producer: identity,
      });
      if (!exported.exported) {
        return fail(`cache-export-${exported.reason || 'refused'}`);
      }
      // Enforce the serialized transport bound before returning the envelope.
      serializeCrossNodeCacheEnvelope(exported.envelope);
      return success({ cacheKey: exported.cacheKey, envelope: exported.envelope });
    } catch {
      return fail('cache-export-invalid');
    }
  }

  if (!exactFields(input, ['descriptor', 'envelope'])) return fail('input-field-set-invalid');
  try {
    const consumed = consumeCrossNodeCacheEnvelope({
      envelope: input.envelope,
      descriptor: input.descriptor,
      consumer: identity,
    });
    if (!consumed.hit) return fail(`cache-consume-${consumed.reason || 'refused'}`);
    return success({
      cacheKey: consumed.cacheKey,
      result: consumed.result,
      reuseEvidence: consumed.reuseEvidence,
    });
  } catch {
    return fail('cache-consume-invalid');
  }
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.length !== 1 || !['export', 'consume'].includes(argv[0])) {
    process.stdout.write(`${JSON.stringify(fail('mode-invalid'))}\n`);
    return 2;
  }
  let input;
  try {
    input = parseInput(readBoundedStdin(dependencies));
  } catch (error) {
    const errorCode = error?.message === 'stdin-size-invalid' ? 'stdin-size-invalid' : 'invalid-json';
    process.stdout.write(`${JSON.stringify(fail(errorCode))}\n`);
    return 1;
  }
  const result = runCrossNodeCacheCommand({ mode: argv[0], input, env: process.env });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
