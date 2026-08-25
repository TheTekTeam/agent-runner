import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeDeterministicWorkCacheEntry } from './agent-runner-deterministic-work-cache.mjs';

const fp = (value) => `sha256:${value.repeat(64).slice(0, 64)}`;

test('cache serializes only positive-allowlisted result metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-work-cache-redaction-'));
  try {
    const stored = writeDeterministicWorkCacheEntry({
      root,
      descriptor: {
        cacheClass: 'analysis',
        projectId: 'agent-runner',
        githubRepo: 'TheTekTeam/agent-runner',
        sourceFingerprint: fp('a'),
        dirtyFingerprint: fp('b'),
        command: 'node',
        argv: ['script.mjs'],
        workingDirectoryIdentity: fp('c'),
        inputDigests: { 'script.mjs': fp('d') },
        lockfileDigest: fp('e'),
        toolchainFingerprint: fp('f'),
        policyFingerprint: fp('1'),
        platformFingerprint: fp('2'),
      },
      result: {
        status: 'success',
        outputDigest: fp('3'),
        resultClass: 'passed',
        counters: { tests: 12, reused: true },
        summary: 'SECRET-SHOULD-NOT-PERSIST',
        evidence: { prompt: 'PROMPT-SHOULD-NOT-PERSIST', token: 'TOKEN-SHOULD-NOT-PERSIST' },
        stdout: 'OUTPUT-SHOULD-NOT-PERSIST',
      },
    });
    const raw = readFileSync(stored.path, 'utf8');
    for (const forbidden of ['SECRET-SHOULD-NOT-PERSIST', 'PROMPT-SHOULD-NOT-PERSIST', 'TOKEN-SHOULD-NOT-PERSIST', 'OUTPUT-SHOULD-NOT-PERSIST']) {
      assert.equal(raw.includes(forbidden), false);
    }
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.result, {
      status: 'success',
      outputDigest: fp('3'),
      resultClass: 'passed',
      counters: { reused: true, tests: 12 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache counters reject strings and nested objects', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-work-cache-redaction-'));
  const descriptor = {
    cacheClass: 'analysis', projectId: 'agent-runner', githubRepo: 'TheTekTeam/agent-runner',
    sourceFingerprint: fp('a'), dirtyFingerprint: fp('b'), command: 'node', argv: ['script.mjs'],
    workingDirectoryIdentity: fp('c'), inputDigests: {}, toolchainFingerprint: fp('f'),
    policyFingerprint: fp('1'), platformFingerprint: fp('2'),
  };
  try {
    assert.throws(() => writeDeterministicWorkCacheEntry({
      root, descriptor, result: { status: 'success', outputDigest: fp('3'), counters: { secret: 'value' } },
    }), /counter secret is invalid/);
    assert.throws(() => writeDeterministicWorkCacheEntry({
      root, descriptor, result: { status: 'success', outputDigest: fp('3'), counters: { nested: { value: 1 } } },
    }), /counter nested is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
