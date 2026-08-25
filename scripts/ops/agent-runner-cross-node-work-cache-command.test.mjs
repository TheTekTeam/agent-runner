import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CROSS_NODE_CACHE_ROOT_ENV,
  NODE_CAPABILITY_ENV,
  NODE_ID_ENV,
  PLATFORM_ENV,
  TOOLCHAIN_ENV,
  runCrossNodeCacheCommand,
} from './agent-runner-cross-node-work-cache-command.mjs';
import { writeDeterministicWorkCacheEntry } from './agent-runner-deterministic-work-cache.mjs';

const fp = (value) => `sha256:${value.repeat(64).slice(0, 64)}`;

function descriptor() {
  return {
    cacheClass: 'analysis',
    freshness: 'reusable',
    projectId: 'agent-runner',
    githubRepo: 'TheTekTeam/agent-runner',
    sourceFingerprint: fp('a'),
    dirtyFingerprint: fp('b'),
    command: 'node',
    argv: ['scripts/ops/example.mjs'],
    workingDirectoryIdentity: fp('c'),
    inputDigests: { 'scripts/ops/example.mjs': fp('d') },
    lockfileDigest: fp('e'),
    toolchainFingerprint: fp('f'),
    validationProfileFingerprint: fp('1'),
    policyFingerprint: fp('2'),
    platformFingerprint: fp('3'),
    implementationRevision: 'v1',
  };
}

function env(root, nodeId, capability) {
  return {
    [CROSS_NODE_CACHE_ROOT_ENV]: root,
    [NODE_ID_ENV]: nodeId,
    [NODE_CAPABILITY_ENV]: capability,
    [TOOLCHAIN_ENV]: fp('f'),
    [PLATFORM_ENV]: fp('3'),
  };
}

test('bounded export/consume command round-trip exposes only cache result and reuse provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-cross-node-command-'));
  try {
    const input = descriptor();
    writeDeterministicWorkCacheEntry({
      root,
      descriptor: input,
      result: { status: 'success', outputDigest: fp('4'), resultClass: 'passed', counters: { checks: 7 } },
      now: () => '2026-08-25T18:00:00.000Z',
    });

    const exported = runCrossNodeCacheCommand({
      mode: 'export',
      input: { descriptor: input },
      env: env(root, 'dev-cluster-z790', fp('5')),
    });
    assert.equal(exported.ok, true);
    assert.equal(exported.envelope.producer.nodeId, 'dev-cluster-z790');

    const consumed = runCrossNodeCacheCommand({
      mode: 'consume',
      input: { descriptor: input, envelope: exported.envelope },
      env: env(root, 'dev-cluster-dell', fp('6')),
    });
    assert.equal(consumed.ok, true);
    assert.deepEqual(consumed.result, {
      status: 'success', outputDigest: fp('4'), resultClass: 'passed', counters: { checks: 7 },
    });
    assert.equal(consumed.reuseEvidence.producerNode, 'dev-cluster-z790');
    assert.equal(consumed.reuseEvidence.consumerNode, 'dev-cluster-dell');

    const serialized = JSON.stringify(consumed);
    for (const forbidden of [root, 'stdout', 'stderr', 'prompt', 'credential', 'session']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command refuses request-controlled cache roots, machine identities and unknown fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-cross-node-command-'));
  try {
    const baseEnv = env(root, 'dev-cluster-z790', fp('5'));
    for (const input of [
      { descriptor: descriptor(), root: '/tmp/attacker' },
      { descriptor: descriptor(), nodeId: 'fake-node' },
      { descriptor: descriptor(), command: 'cat /etc/passwd' },
    ]) {
      const result = runCrossNodeCacheCommand({ mode: 'export', input, env: baseEnv });
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'input-field-set-invalid');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing or malformed machine capability identity fails closed before cache access', () => {
  const result = runCrossNodeCacheCommand({
    mode: 'export',
    input: { descriptor: descriptor() },
    env: {
      [CROSS_NODE_CACHE_ROOT_ENV]: '/tmp/unused',
      [NODE_ID_ENV]: 'dev-cluster-z790',
      [NODE_CAPABILITY_ENV]: 'not-a-fingerprint',
      [TOOLCHAIN_ENV]: fp('f'),
      [PLATFORM_ENV]: fp('3'),
    },
  });
  assert.deepEqual(result, { schemaVersion: 1, ok: false, errorCode: 'machine-identity-invalid' });
});

test('consumer incompatibility returns a bounded refusal without raw diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-cross-node-command-'));
  try {
    const input = descriptor();
    writeDeterministicWorkCacheEntry({
      root,
      descriptor: input,
      result: { status: 'success', outputDigest: fp('4') },
    });
    const exported = runCrossNodeCacheCommand({
      mode: 'export', input: { descriptor: input }, env: env(root, 'dev-cluster-z790', fp('5')),
    });
    assert.equal(exported.ok, true);

    const incompatible = runCrossNodeCacheCommand({
      mode: 'consume',
      input: { descriptor: input, envelope: exported.envelope },
      env: { ...env(root, 'dev-cluster-dell', fp('6')), [PLATFORM_ENV]: fp('0') },
    });
    assert.equal(incompatible.ok, false);
    assert.equal(incompatible.errorCode, 'cache-consume-consumer-platform-mismatch');
    assert.deepEqual(Object.keys(incompatible).sort(), ['errorCode', 'ok', 'schemaVersion']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
