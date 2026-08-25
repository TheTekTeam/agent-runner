import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DETERMINISTIC_WORK_FRESHNESS,
  createDeterministicWorkCacheKey,
  pruneDeterministicWorkCache,
  readDeterministicWorkCacheEntry,
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-work-cache-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('exact key hit reuses successful deterministic work', () => {
  const value = fixture();
  try {
    const input = descriptor();
    const stored = writeDeterministicWorkCacheEntry({
      root: value.root,
      descriptor: input,
      result: { status: 'success', outputDigest: fp('4'), summary: 'focused tests passed' },
      now: () => '2026-08-25T00:00:00.000Z',
    });
    assert.equal(stored.stored, true);
    const read = readDeterministicWorkCacheEntry({ root: value.root, descriptor: input });
    assert.equal(read.hit, true);
    assert.equal(read.cacheKey, stored.cacheKey);
    assert.equal(read.result.outputDigest, fp('4'));
  } finally {
    value.cleanup();
  }
});

test('material source, argv, lockfile, toolchain or policy changes cause misses', () => {
  const value = fixture();
  try {
    const input = descriptor();
    writeDeterministicWorkCacheEntry({
      root: value.root,
      descriptor: input,
      result: { status: 'success', outputDigest: fp('4') },
    });
    const changed = [
      descriptor({ sourceFingerprint: fp('5') }),
      descriptor({ argv: ['--test', 'scripts/ops/other.test.mjs'] }),
      descriptor({ lockfileDigest: fp('6') }),
      descriptor({ toolchainFingerprint: fp('7') }),
      descriptor({ policyFingerprint: fp('8') }),
    ];
    for (const candidate of changed) {
      assert.equal(readDeterministicWorkCacheEntry({ root: value.root, descriptor: candidate }).hit, false);
    }
  } finally {
    value.cleanup();
  }
});

test('dirty state and project identity are part of the cache key', () => {
  const a = createDeterministicWorkCacheKey(descriptor()).cacheKey;
  const dirty = createDeterministicWorkCacheKey(descriptor({ dirtyFingerprint: fp('9') })).cacheKey;
  const project = createDeterministicWorkCacheKey(descriptor({ projectId: 'other-project' })).cacheKey;
  assert.notEqual(a, dirty);
  assert.notEqual(a, project);
});

test('fresh-required validation cannot be written or reused', () => {
  const value = fixture();
  try {
    const input = descriptor({ cacheClass: 'validation-evidence', freshness: 'fresh-required' });
    const stored = writeDeterministicWorkCacheEntry({
      root: value.root,
      descriptor: input,
      result: { status: 'success', outputDigest: fp('4') },
    });
    assert.deepEqual({ stored: stored.stored, reason: stored.reason }, { stored: false, reason: 'fresh-required' });
    const read = readDeterministicWorkCacheEntry({ root: value.root, descriptor: input });
    assert.equal(read.hit, false);
    assert.equal(read.reason, 'fresh-required');
  } finally {
    value.cleanup();
  }
});

test('failed deterministic work cannot be serialized as reusable success', () => {
  const value = fixture();
  try {
    assert.throws(() => writeDeterministicWorkCacheEntry({
      root: value.root,
      descriptor: descriptor(),
      result: { status: 'failed', outputDigest: fp('4') },
    }), /only successful deterministic work may be cached/);
  } finally {
    value.cleanup();
  }
});

test('host-sensitive results fail closed across incompatible toolchain or platform', () => {
  const value = fixture();
  try {
    const input = descriptor();
    writeDeterministicWorkCacheEntry({
      root: value.root,
      descriptor: input,
      result: { status: 'success', outputDigest: fp('4') },
    });
    assert.equal(readDeterministicWorkCacheEntry({
      root: value.root,
      descriptor: input,
      consumer: { toolchainFingerprint: fp('0'), platformFingerprint: fp('3') },
    }).reason, 'host-or-toolchain-mismatch');
    assert.equal(readDeterministicWorkCacheEntry({
      root: value.root,
      descriptor: input,
      consumer: { toolchainFingerprint: fp('f'), platformFingerprint: fp('0') },
    }).reason, 'host-or-toolchain-mismatch');
  } finally {
    value.cleanup();
  }
});

test('tampered entry is rejected rather than reused', () => {
  const value = fixture();
  try {
    const input = descriptor();
    const stored = writeDeterministicWorkCacheEntry({
      root: value.root,
      descriptor: input,
      result: { status: 'success', outputDigest: fp('4') },
    });
    const record = JSON.parse(readFileSync(stored.path, 'utf8'));
    record.result.outputDigest = fp('5');
    writeFileSync(stored.path, `${JSON.stringify(record)}\n`, 'utf8');
    const read = readDeterministicWorkCacheEntry({ root: value.root, descriptor: input });
    assert.equal(read.hit, false);
    assert.equal(read.reason, 'integrity-mismatch');
  } finally {
    value.cleanup();
  }
});

test('bounded retention prunes old cache entries without affecting correctness semantics', () => {
  const value = fixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      writeDeterministicWorkCacheEntry({
        root: value.root,
        descriptor: descriptor({ inputDigests: { file: fp(String(index + 1)) } }),
        result: { status: 'success', outputDigest: fp('4') },
      });
    }
    const result = pruneDeterministicWorkCache({ root: value.root, maxEntries: 1, maxBytes: 1024 * 1024 });
    assert.equal(result.remaining, 1);
    assert.equal(result.removed, 2);
  } finally {
    value.cleanup();
  }
});
