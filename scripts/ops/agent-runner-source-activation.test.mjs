import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync as fsReadFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SourceActivationRefusal,
  activateAgentRunnerSource,
  parseActivationArgs,
  validateTargetSha,
} from './agent-runner-source-activation.mjs';

const OLD = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function harness({
  oldHead = OLD,
  fetched = TARGET,
  branch = 'main',
  dirty = false,
  ancestorStatus = 0,
  fetchStatus = 0,
  mergeStatus = 0,
  repoIdentity = '/repo',
  lockError = null,
} = {}) {
  let currentHead = oldHead;
  let lockPresent = false;
  let mergeCalls = 0;
  let fetchCalls = 0;
  const calls = [];
  const evidence = [];

  const runGit = (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return { status: 0, stdout: `${repoIdentity}\n` };
    if (key === 'symbolic-ref --quiet --short HEAD') return { status: 0, stdout: `${branch}\n` };
    if (key === 'status --porcelain=v1 --untracked-files=all') {
      return { status: 0, stdout: dirty ? '?? unexpected.txt\n' : '' };
    }
    if (key === 'rev-parse --verify HEAD^{commit}') return { status: 0, stdout: `${currentHead}\n` };
    if (key === 'remote get-url origin') return { status: 0, stdout: 'git@github.com:TheTekTeam/agent-runner.git\n' };
    if (key === 'fetch --no-tags origin refs/heads/main:refs/remotes/origin/main') {
      fetchCalls += 1;
      return { status: fetchStatus, stdout: '' };
    }
    if (key === 'rev-parse --verify refs/remotes/origin/main^{commit}') return { status: 0, stdout: `${fetched}\n` };
    if (key === `merge-base --is-ancestor ${currentHead} ${TARGET}`) return { status: ancestorStatus, stdout: '' };
    if (key === `merge --ff-only --no-edit ${TARGET}`) {
      mergeCalls += 1;
      if (mergeStatus === 0) currentHead = TARGET;
      return { status: mergeStatus, stdout: '' };
    }
    throw new Error(`unexpected git command: ${key}`);
  };

  const acquireLock = () => {
    if (lockError) throw lockError;
    lockPresent = true;
    return () => { lockPresent = false; };
  };
  const readFile = () => {
    if (!lockPresent) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return '123\n2026-08-17T21:00:00.000Z\n';
  };
  const exists = () => lockPresent;
  const writeEvidence = (record) => {
    evidence.push(structuredClone(record));
    return '/machine/local/secret/evidence.json';
  };

  const options = {
    target: TARGET,
    env: {
      HOME: '/home/gp',
      AGENT_RUNNER_HOME: '/repo',
      AGENT_RUNNER_IMPLEMENTATION_LOCK: '/state/implementation.lock',
    },
    repositoryRoot: '/repo',
    runGit,
    acquireLock,
    realpath: (value) => value,
    getuid: () => 1000,
    now: () => '2026-08-17T21:00:00.000Z',
    writeEvidence,
    exists,
    readFile,
  };

  return {
    options,
    calls,
    evidence,
    get mergeCalls() { return mergeCalls; },
    get fetchCalls() { return fetchCalls; },
    get currentHead() { return currentHead; },
  };
}

test('requires exactly one full target SHA and rejects caller-controlled remote/path options', () => {
  assert.equal(validateTargetSha(TARGET.toUpperCase()), TARGET);
  assert.throws(() => validateTargetSha('b'.repeat(12)), /full 40-character commit SHA/);
  assert.deepEqual(parseActivationArgs(['--target', TARGET]), { help: false, target: TARGET });
  assert.throws(() => parseActivationArgs(['--target', TARGET, '--remote', 'evil']), (error) => {
    assert.equal(error instanceof SourceActivationRefusal, true);
    assert.equal(error.reason, 'unsupported-argument');
    return true;
  });
  assert.throws(() => parseActivationArgs(['--repo', '/tmp/other', '--target', TARGET]), /Unsupported source-activation argument/);
});

test('clean ancestor activates exact fetched target by ff-only under one lock', async () => {
  const h = harness();
  const result = await activateAgentRunnerSource(h.options);
  assert.equal(result.ok, true);
  assert.equal(result.result, 'activated');
  assert.equal(result.oldHead, OLD);
  assert.equal(result.target, TARGET);
  assert.equal(result.finalHead, TARGET);
  assert.equal(h.currentHead, TARGET);
  assert.equal(h.mergeCalls, 1);
  assert.equal(h.fetchCalls, 1);
  assert.equal(h.evidence.at(-1).lockAcquired, true);
  assert.equal(h.evidence.at(-1).lockReleased, true);
  assert.equal(h.evidence.at(-1).result, 'activated');
  assert.equal(h.evidence.at(-1).refusalReason, null);
});

test('already-active target still fetches and verifies but performs no merge', async () => {
  const h = harness({ oldHead: TARGET });
  const result = await activateAgentRunnerSource(h.options);
  assert.equal(result.result, 'already-active');
  assert.equal(h.fetchCalls, 1);
  assert.equal(h.mergeCalls, 0);
  assert.equal(h.currentHead, TARGET);
});

test('wrong branch refuses before fetch or merge and preserves checkout', async () => {
  const h = harness({ branch: 'feature' });
  await assert.rejects(() => activateAgentRunnerSource(h.options), (error) => {
    assert.equal(error.reason, 'wrong-branch');
    return true;
  });
  assert.equal(h.fetchCalls, 0);
  assert.equal(h.mergeCalls, 0);
  assert.equal(h.currentHead, OLD);
  assert.equal(h.evidence.at(-1).refusalReason, 'wrong-branch');
  assert.equal(h.evidence.at(-1).lockReleased, true);
});

test('dirty checkout including untracked files refuses before fetch or merge', async () => {
  const h = harness({ dirty: true });
  await assert.rejects(() => activateAgentRunnerSource(h.options), (error) => {
    assert.equal(error.reason, 'dirty-checkout');
    return true;
  });
  assert.equal(h.fetchCalls, 0);
  assert.equal(h.mergeCalls, 0);
  assert.equal(h.currentHead, OLD);
});

test('fetched origin/main must exactly equal requested target', async () => {
  const h = harness({ fetched: OTHER });
  await assert.rejects(() => activateAgentRunnerSource(h.options), (error) => {
    assert.equal(error.reason, 'target-origin-mismatch');
    return true;
  });
  assert.equal(h.fetchCalls, 1);
  assert.equal(h.mergeCalls, 0);
  assert.equal(h.currentHead, OLD);
});

test('diverged/non-fast-forward local main refuses without checkout mutation', async () => {
  const h = harness({ ancestorStatus: 1 });
  await assert.rejects(() => activateAgentRunnerSource(h.options), (error) => {
    assert.equal(error.reason, 'non-fast-forward-target');
    return true;
  });
  assert.equal(h.mergeCalls, 0);
  assert.equal(h.currentHead, OLD);
});

test('fetch and merge-base failures fail closed with bounded reasons', async () => {
  const fetch = harness({ fetchStatus: 1 });
  await assert.rejects(() => activateAgentRunnerSource(fetch.options), (error) => {
    assert.equal(error.reason, 'origin-fetch-failed');
    return true;
  });
  assert.equal(fetch.mergeCalls, 0);

  const mergeBase = harness({ ancestorStatus = 2 });
  await assert.rejects(() => activateAgentRunnerSource(mergeBase.options), (error) => {
    assert.equal(error.reason, 'merge-base-failed');
    return true;
  });
  assert.equal(mergeBase.mergeCalls, 0);
});

test('active or ambiguous implementation lock refusal does not run git', async () => {
  const lockError = new Error('lock held');
  lockError.code = 'AGENT_RUNNER_LOCKED';
  const h = harness({ lockError });
  await assert.rejects(() => activateAgentRunnerSource(h.options), (error) => {
    assert.equal(error.code, 'AGENT_RUNNER_LOCKED');
    return true;
  });
  assert.equal(h.calls.length, 0);
  assert.equal(h.evidence.at(-1).refusalReason, 'implementation-lock-unavailable');
  assert.equal(h.evidence.at(-1).lockAcquired, false);
  assert.equal(h.evidence.at(-1).lockReleased, false);
});

test('canonical checkout identity and AGENT_RUNNER_HOME are fail-closed', async () => {
  const mismatchedGit = harness({ repoIdentity: '/other' });
  await assert.rejects(() => activateAgentRunnerSource(mismatchedGit.options), (error) => {
    assert.equal(error.reason, 'canonical-repository-mismatch');
    return true;
  });
  assert.equal(mismatchedGit.mergeCalls, 0);

  const h = harness();
  h.options.env.AGENT_RUNNER_HOME = '/other';
  await assert.rejects(() => activateAgentRunnerSource(h.options), (error) => {
    assert.equal(error.reason, 'configured-agent-runner-home-mismatch');
    return true;
  });
  assert.equal(h.calls.length, 0);
});

test('root execution and abbreviated target refuse before lock/git mutation', async () => {
  const root = harness();
  root.options.getuid = () => 0;
  await assert.rejects(() => activateAgentRunnerSource(root.options), (error) => {
    assert.equal(error.reason, 'root-execution-forbidden');
    return true;
  });
  assert.equal(root.calls.length, 0);
  assert.equal(root.evidence.length, 0);

  const short = harness();
  short.options.target = 'a'.repeat(12);
  await assert.rejects(() => activateAgentRunnerSource(short.options), (error) => {
    assert.equal(error.reason, 'invalid-target-sha');
    return true;
  });
  assert.equal(short.calls.length, 0);
});

test('bounded evidence excludes remote URL, paths, env, prompts and git output', async () => {
  const h = harness();
  await activateAgentRunnerSource(h.options);
  const serialized = JSON.stringify(h.evidence.at(-1));
  assert.doesNotMatch(serialized, /github\.com/);
  assert.doesNotMatch(serialized, /\/home\/gp|\/repo|\/state|machine\/local/);
  assert.doesNotMatch(serialized, /AGENT_RUNNER|prompt|stderr|stdout|remote/i);
  assert.deepEqual(Object.keys(h.evidence.at(-1)).sort(), [
    'branch',
    'cleanAfter',
    'cleanBefore',
    'fastForwardEligible',
    'fetchedOriginMain',
    'finalHead',
    'lockAcquired',
   'lockReleased',
    'oldHead',
    'recordedAt',
    'refusalReason',
    'requestedTarget',
   'result',
    'schemaVersion',
  ].sort());
});


test('default evidence is mode 0600 and malformed stale global lock fails closed', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'agent-runner-source-activation-'));
  try {
    const first = harness();
    first.options.env = {
      HOME: temp,
      AGENT_RUNNER_HOME: '/repo',
      AGENT_RUNNER_IMPLEMENTATION_LOCK: join(temp, 'implementation.lock'),
      AGENT_RUNNER_SOURCE_ACTIVATION_EVIDENCE_DIR: join(temp, 'evidence'),
    };
    delete first.options.acquireLock;
    delete first.options.writeEvidence;
    delete first.options.exists;
    delete first.options.readFile;

    const result = await activateAgentRunnerSource(first.options);
    assert.equal(result.ok, true);
    const files = readdirSync(join(temp, 'evidence'));
    assert.equal(files.length, 1);
    const evidencePath = join(temp, 'evidence', files[0]);
    assert.equal(statSync(hevidencePath).mode & 0o777, 0o600);
    const record = JSON.parse(fsReadFileSync(evidencePath, 'utf8'));
    assert.equal(record.lockAcquired, true);
    assert.equal(record.lockReleased, true);

    const malformed = harness();
    malformed.options.env = {
      HOME: temp,
      AGENT_RUNNER_HOME: '/repo',
      AGENT_RUNNER_IMPLEMENTATION_LOCK: join(temp, 'malformed.lock'),
      AGENT_RUNNER_SOURCE_ACTIVATION_EVIDENCE_DIR: join(temp, 'malformed-evidence'),
    };
    fsWriteFileSync(malformed.options.env.AGENT_RUNNER_IMPLEMENTATION_LOCK, 'corrupt lock data\n');
    delete malformed.options.acquireLock;
    delete malformed.options.writeEvidence;
    delete malformed.options.exists;
    delete malformed.options.readFile;

    await assert.rejects(() => activateAgentRunnerSource(malformed.options), (error) => {
      assert.equal(error.code, 'AGENT_RUNNER_LOCKED');
      return true;
    });
    assert.equal(fsReadFileSync(malformed.options.env.AGENT_RUNNER_IMPLEMENTATION_LOCK, 'utf8'), 'corrupt lock data\n');
    assert.equal(malformed.calls.length, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
