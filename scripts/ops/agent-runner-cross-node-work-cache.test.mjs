import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  consumeCrossNodeCacheEnvelope,
  exportCrossNodeCacheEnvelope,
  parseCrossNodeCacheEnvelope,
  serializeCrossNodeCacheEnvelope,
  validateCrossNodeCacheEnvelope,
} from './agent-runner-cross-node-work-cache.mjs';
import {
  DETERMINISTIC_WORK_FRESHNESS,
  writeDeterministicWorkCacheEntry,
} from './agent-runner-deterministic-work-cache.mjs';

const fp = (value) => `sha256:${value.repeat(64).slice(0, 64)}`;

function descriptor(overrides = {}) {
  return {
    cacheClass: 'test-substep',
    freshness: DETERMINISTIC_WORK_FRESHNESS.REUSABLE,
    projectId: 'agent-runner',
    githubRepo: 'TheTekTeam/agent-runner',
    sourceFingerprint: fp('a'),
    dirtyFingerprint: fp('b'),
    command: 'node',
    argv: ['--test', 'scripts/ops/example.test.mjs'],
    workingDirectoryIdentity: fp('c'),
    inputDigests: { 'scripts/ops/example.test.mjs': fp('d') },
    lockfileDigest: fp('e'),
    toolchainFingerprint: fp('f'),
    validationProfileFingerprint: fp('1'),
    policyFingerprint: fp('2'),
    platformFingerprint: fp('3'),
    implementationRevision: 'v1',
    ...overrides,
  };
}

function node(nodeId, overrides = {}) {
  return {
    nodeId,
    capabilityFingerprint: nodeId === 'dev-cluster-z790' ? fp('4') : fp('5'),
    toolchainFingerprint: fp('f'),
    platformFingerprint: fp('3'),
    ...overrides,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-cross-node-cache-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function produce(root, input = descriptor()) {
  const stored = writeDeterministicWorkCacheEntry({
    root,
    descriptor: input,
    result: {
      status: 'success',
      outputDigest: fp('6'),
      resultClass: 'passed',
      counters: { tests: 12 },
    },
    producer: {
      nodeId: 'dev-cluster-z790',
      toolchainFingerprint: fp('f'),
    },
    now: () => '2026-08-25T18:00:00.000Z',
  });
  assert.equal(stored.stored, true);
  return stored;
}

test('exact compatible Z790-to-Dell cache record is consumed with producer and consumer binding', () => {
  const value = fixture();
  try {
    const input = descriptor();
    produce(value.root, input);
    const exported = exportCrossNodeCacheEnvelope({
      root: value.root,
      descriptor: input,
      producer: node('dev-cluster-z790'),
    });
    assert.equal(exported.exported, true);
    assert.match(exported.envelope.envelopeDigest, /^sha256:[a-f0-9]{64}$/);

    const serialized = serializeCrossNodeCacheEnvelope(exported.envelope);
    const parsed = validateCrossNodeCacheEnvelope(parseCrossNodeCacheEnvelope(serialized));
    assert.equal(parsed.cacheKey, exported.cacheKey);

    const consumed = consumeCrossNodeCacheEnvelope({
      envelope: serialized,
      descriptor: input,
      consumer: node('dev-cluster-dell'),
    });
    assert.equal(consumed.hit, true);
    assert.equal(consumed.result.outputDigest, fp('6'));
    assert.equal(consumed.reuseEvidence.reuseStatus, 'cross-node-hit');
    assert.equal(consumed.reuseEvidence.producerNode, 'dev-cluster-z790');
    assert.equal(consumed.reuseEvidence.consumerNode, 'dev-cluster-dell');
    assert.equal(consumed.reuseEvidence.producerCapabilityFingerprint, fp('4'));
    assert.equal(consumed.reuseEvidence.consumerCapabilityFingerprint, fp('5'));
    assert.match(consumed.reuseEvidence.reuseFingerprint, /^sha256:[a-f0-9]{64}$/);
  } finally {
    value.cleanup();
  }
});

test('one material source, argv, lockfile or policy change misses on the consumer', () => {
  const value = fixture();
  try {
    const input = descriptor();
    produce(value.root, input);
    const exported = exportCrossNodeCacheEnvelope({ root: value.root, descriptor: input, producer: node('dev-cluster-z790') });
    assert.equal(exported.exported, true);

    for (const changed of [
      descriptor({ sourceFingerprint: fp('7') }),
      descriptor({ argv: ['--test', 'scripts/ops/other.test.mjs'] }),
      descriptor({ lockfileDigest: fp('8') }),
      descriptor({ policyFingerprint: fp('9') }),
    ]) {
      const consumed = consumeCrossNodeCacheEnvelope({
        envelope: exported.envelope,
        descriptor: changed,
        consumer: node('dev-cluster-dell'),
      });
      assert.equal(consumed.hit, false);
      assert.equal(consumed.reason, 'cache-key-or-descriptor-mismatch');
    }
  } finally {
    value.cleanup();
  }
});

test('host-sensitive cache rejects incompatible consumer toolchain or platform', () => {
  const value = fixture();
  try {
    const input = descriptor();
    produce(value.root, input);
    const exported = exportCrossNodeCacheEnvelope({ root: value.root, descriptor: input, producer: node('dev-cluster-z790') });

    const toolchainMiss = consumeCrossNodeCacheEnvelope({
      envelope: exported.envelope,
      descriptor: input,
      consumer: node('dev-cluster-dell', { toolchainFingerprint: fp('0') }),
    });
    assert.equal(toolchainMiss.hit, false);
    assert.equal(toolchainMiss.reason, 'consumer-toolchain-mismatch');

    const platformMiss = consumeCrossNodeCacheEnvelope({
      envelope: exported.envelope,
      descriptor: input,
      consumer: node('dev-cluster-dell', { platformFingerprint: fp('0') }),
    });
    assert.equal(platformMiss.hit, false);
    assert.equal(platformMiss.reason, 'consumer-platform-mismatch');
  } finally {
    value.cleanup();
  }
});

test('explicit host-independent class permits platform difference but still binds toolchain and consumer capability', () => {
  const value = fixture();
  try {
    const input = descriptor({ hostIndependent: true });
    produce(value.root, input);
    const exported = exportCrossNodeCacheEnvelope({
      root: value.root,
      descriptor: input,
      producer: node('dev-cluster-z790', { platformFingerprint: fp('9') }),
    });
    assert.equal(exported.exported, true);
    assert.equal(exported.envelope.compatibility.class, 'host-independent');

    const consumed = consumeCrossNodeCacheEnvelope({
      envelope: exported.envelope,
      descriptor: input,
      consumer: node('dev-cluster-dell', { platformFingerprint: fp('0') }),
    });
    assert.equal(consumed.hit, true);
    assert.equal(consumed.reuseEvidence.compatibilityClass, 'host-independent');

    const wrongToolchain = consumeCrossNodeCacheEnvelope({
      envelope: exported.envelope,
      descriptor: input,
      consumer: node('dev-cluster-dell', { toolchainFingerprint: fp('0'), platformFingerprint: fp('0') }),
    });
    assert.equal(wrongToolchain.hit, false);
    assert.equal(wrongToolchain.reason, 'consumer-toolchain-mismatch');
  } finally {
    value.cleanup();
  }
});

test('corrupted or tampered envelope is rejected before reuse', () => {
  const value = fixture();
  try {
    const input = descriptor();
    produce(value.root, input);
    const exported = exportCrossNodeCacheEnvelope({ root: value.root, descriptor: input, producer: node('dev-cluster-z790') });
    const tampered = structuredClone(exported.envelope);
    tampered.result.outputDigest = fp('7');
    const consumed = consumeCrossNodeCacheEnvelope({
      envelope: tampered,
      descriptor: input,
      consumer: node('dev-cluster-dell'),
    });
    assert.equal(consumed.hit, false);
    assert.equal(consumed.reason, 'invalid-or-tampered-envelope');
  } finally {
    value.cleanup();
  }
});

test('fresh-required work is never exported cross-node', () => {
  const value = fixture();
  try {
    const input = descriptor({ cacheClass: 'validation-evidence', freshness: DETERMINISTIC_WORK_FRESHNESS.FRESH_REQUIRED });
    const exported = exportCrossNodeCacheEnvelope({ root: value.root, descriptor: input, producer: node('dev-cluster-z790') });
    assert.equal(exported.exported, false);
    assert.equal(exported.reason, 'fresh-required');
    assert.equal(exported.envelope, null);
  } finally {
    value.cleanup();
  }
});

test('portable descriptor refuses obvious secrets, absolute paths and traversal', () => {
  const value = fixture();
  try {
    for (const input of [
      descriptor({ argv: ['--header', 'Authorization=Bearer secret-value'] }),
      descriptor({ argv: ['/home/gp/private/file'] }),
      descriptor({ inputDigests: { '../outside': fp('d') } }),
      descriptor({ command: '/bin/node' }),
    ]) {
      assert.throws(() => exportCrossNodeCacheEnvelope({
        root: value.root,
        descriptor: input,
        producer: node('dev-cluster-z790'),
      }));
    }
  } finally {
    value.cleanup();
  }
});

test('failed or missing local cache entries cannot be exported as cross-node success', () => {
  const value = fixture();
  try {
    const input = descriptor();
    const missing = exportCrossNodeCacheEnvelope({ root: value.root, descriptor: input, producer: node('dev-cluster-z790') });
    assert.equal(missing.exported, false);
    assert.equal(missing.reason, 'miss-or-corrupt');

    const stored = produce(value.root, input);
    writeFileSync(stored.path, '{"corrupt":true}\n', 'utf8');
    const corrupt = exportCrossNodeCacheEnvelope({ root: value.root, descriptor: input, producer: node('dev-cluster-z790') });
    assert.equal(corrupt.exported, false);
    assert.equal(corrupt.reason, 'schema-mismatch');
  } finally {
    value.cleanup();
  }
});
