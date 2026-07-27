import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  detectClaudeResumeCliCapability,
  readRestrictedRecoveryHandle,
  restrictedHandleBindingDigest,
  restrictedHandleDigest,
  restrictedRecoveryDir,
  verifyPreservedWorktree,
  writeRestrictedRecoveryHandle,
} from './claude-runner-recovery-adapter.mjs';
import { fingerprintGitStatus } from './claude-runner-execution-policy.mjs';

test('writeRestrictedRecoveryHandle writes a mode-0700 directory and mode-0600 file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-1', { attemptId: 'attempt-1', sessionId: 'session-secret' });
    const dirStats = statSync(restrictedRecoveryDir(dir));
    assert.equal(dirStats.mode & 0o777, 0o700);
    const filePath = join(restrictedRecoveryDir(dir), 'attempt-1.json');
    const fileStats = statSync(filePath);
    assert.equal(fileStats.mode & 0o777, 0o600);
    assert.match(readFileSync(filePath, 'utf8'), /session-secret/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRestrictedRecoveryHandle round-trips a written handle and returns a stable digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    const handle = { attemptId: 'attempt-2', sessionId: 'abc', worktreeName: 'agent-runner-698-41', expectedBranch: 'worktree-agent-runner-698-41' };
    const written = writeRestrictedRecoveryHandle(dir, 'attempt-2', handle);
    const read = readRestrictedRecoveryHandle(dir, 'attempt-2');
    assert.equal(read.available, true);
    assert.equal(read.permissionSafe, true);
    assert.deepEqual(read.handle, handle);
    assert.equal(read.digest, written.digest);
    assert.equal(read.digest, restrictedHandleDigest(handle));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRestrictedRecoveryHandle fails closed on a missing handle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    const read = readRestrictedRecoveryHandle(dir, 'never-written');
    assert.equal(read.available, false);
    assert.equal(read.permissionSafe, true);
    assert.equal(read.handle, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRestrictedRecoveryHandle fails closed on an attempt id mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-3', { attemptId: 'attempt-3', sessionId: 'x' });
    const read = readRestrictedRecoveryHandle(dir, 'attempt-3', {
      readFn: () => JSON.stringify({ attemptId: 'a-different-attempt', sessionId: 'x' }),
    });
    assert.equal(read.available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRestrictedRecoveryHandle fails closed when the file mode is broader than owner-only (0644)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-4', { attemptId: 'attempt-4', sessionId: 'x' });
    chmodSync(join(restrictedRecoveryDir(dir), 'attempt-4.json'), 0o644);
    const read = readRestrictedRecoveryHandle(dir, 'attempt-4');
    assert.equal(read.available, false);
    assert.equal(read.permissionSafe, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRestrictedRecoveryHandle fails closed when the enclosing directory mode is broader than owner-only (0755)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-4b', { attemptId: 'attempt-4b', sessionId: 'x' });
    chmodSync(restrictedRecoveryDir(dir), 0o755);
    const read = readRestrictedRecoveryHandle(dir, 'attempt-4b');
    assert.equal(read.available, false);
    assert.equal(read.permissionSafe, false);
  } finally {
    chmodSync(restrictedRecoveryDir(dir), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRestrictedRecoveryHandle fails closed when the handle path is a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  const outside = mkdtempSync(join(tmpdir(), 'restricted-recovery-outside-'));
  try {
    const realTarget = join(outside, 'target.json');
    writeFileSync(realTarget, JSON.stringify({ attemptId: 'attempt-5', sessionId: 'x' }), { mode: 0o600 });
    mkdirSync(restrictedRecoveryDir(dir), { recursive: true, mode: 0o700 });
    symlinkSync(realTarget, join(restrictedRecoveryDir(dir), 'attempt-5.json'));
    const read = readRestrictedRecoveryHandle(dir, 'attempt-5');
    assert.equal(read.available, false);
    assert.equal(read.permissionSafe, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('readRestrictedRecoveryHandle fails closed when the enclosing directory is a symlink', () => {
  const parent = mkdtempSync(join(tmpdir(), 'restricted-recovery-parent-'));
  const realDir = mkdtempSync(join(tmpdir(), 'restricted-recovery-real-'));
  try {
    writeRestrictedRecoveryHandle(realDir, 'attempt-6', { attemptId: 'attempt-6', sessionId: 'x' });
    // Point the symlinked "outputDir/.restricted-recovery" at the real, correctly-permissioned directory.
    symlinkSync(restrictedRecoveryDir(realDir), restrictedRecoveryDir(parent));
    const read = readRestrictedRecoveryHandle(parent, 'attempt-6');
    assert.equal(read.available, false);
    assert.equal(read.permissionSafe, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  }
});

test('readRestrictedRecoveryHandle fails closed when ownership evidence is ambiguous or wrong', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    writeRestrictedRecoveryHandle(dir, 'attempt-7', { attemptId: 'attempt-7', sessionId: 'x' });
    const wrongOwnerStats = (path) => ({
      ...statSync(path),
      uid: (typeof process.getuid === 'function' ? process.getuid() : 0) + 1,
      isSymbolicLink: () => false,
      isDirectory: () => statSync(path).isDirectory(),
      isFile: () => statSync(path).isFile(),
    });
    const read = readRestrictedRecoveryHandle(dir, 'attempt-7', { lstatFn: wrongOwnerStats });
    assert.equal(read.available, false);
    assert.equal(read.permissionSafe, false);

    const ambiguousStats = () => ({ mode: undefined, uid: undefined, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => true });
    const ambiguousRead = readRestrictedRecoveryHandle(dir, 'attempt-7', { lstatFn: ambiguousStats });
    assert.equal(ambiguousRead.available, false);
    assert.equal(ambiguousRead.permissionSafe, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRestrictedRecoveryHandle throws (does not silently swallow) a chmod failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    assert.throws(() => {
      writeRestrictedRecoveryHandle(dir, 'attempt-8', { attemptId: 'attempt-8', sessionId: 'x' }, {
        chmodFn: () => { throw new Error('chmod denied'); },
      });
    }, /chmod denied/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRestrictedRecoveryHandle throws (does not silently swallow) a write failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    assert.throws(() => {
      writeRestrictedRecoveryHandle(dir, 'attempt-9', { attemptId: 'attempt-9', sessionId: 'x' }, {
        writeFn: () => { throw new Error('disk full'); },
      });
    }, /disk full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRestrictedRecoveryHandle throws (does not silently swallow) a rename failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    assert.throws(() => {
      writeRestrictedRecoveryHandle(dir, 'attempt-10', { attemptId: 'attempt-10', sessionId: 'x' }, {
        renameFn: () => { throw new Error('rename failed across devices'); },
      });
    }, /rename failed across devices/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRestrictedRecoveryHandle throws when post-write verification finds a wrong final mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restricted-recovery-'));
  try {
    assert.throws(() => {
      writeRestrictedRecoveryHandle(dir, 'attempt-11', { attemptId: 'attempt-11', sessionId: 'x' }, {
        // Force the temporary file to the known-wrong final mode after the
        // write, independent of the process umask, then suppress correction.
        writeFn: (path, data, options) => {
          writeFileSync(path, data, options);
          chmodSync(path, 0o644);
        },
        chmodFn: () => {},
      });
    }, /permission verification/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRestrictedRecoveryHandle succeeds and round-trips under umask 022 and 077 with genuine owner-exclusive 0700/0600 permissions', () => {
  for (const mask of [0o022, 0o077]) {
    const previousMask = process.umask(mask);
    const dir = mkdtempSync(join(tmpdir(), `restricted-recovery-umask-${mask.toString(8)}-`));
    try {
      const attemptId = `attempt-12-${mask.toString(8)}`;
      writeRestrictedRecoveryHandle(dir, attemptId, { attemptId, sessionId: 'x' });
      const dirStats = statSync(restrictedRecoveryDir(dir));
      assert.equal(dirStats.mode & 0o777, 0o700);
      assert.equal(dirStats.uid, process.getuid());
      const filePath = join(restrictedRecoveryDir(dir), `${attemptId}.json`);
      const fileStats = statSync(filePath);
      assert.equal(fileStats.mode & 0o777, 0o600);
      assert.equal(fileStats.uid, process.getuid());
      const read = readRestrictedRecoveryHandle(dir, attemptId);
      assert.equal(read.available, true);
      assert.equal(read.permissionSafe, true);
    } finally {
      process.umask(previousMask);
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('detectClaudeResumeCliCapability requires a compatible version plus both --resume and --worktree in --help', () => {
  const runner = (bin, args) => {
    if (args[0] === '--version') return '2.1.208 (Claude Code)\n';
    if (args[0] === '--help') return '  -r, --resume [value]\n  --worktree <name>\n';
    throw new Error('unexpected');
  };
  const result = detectClaudeResumeCliCapability({ claudeBin: 'claude', runner });
  assert.equal(result.supported, true);
  assert.equal(result.resumeFlagPresent, true);
  assert.equal(result.worktreeFlagPresent, true);
});

test('detectClaudeResumeCliCapability fails closed when --help omits --resume', () => {
  const runner = (bin, args) => {
    if (args[0] === '--version') return '2.1.208 (Claude Code)\n';
    if (args[0] === '--help') return '  --worktree <name>\n';
    throw new Error('unexpected');
  };
  const result = detectClaudeResumeCliCapability({ claudeBin: 'claude', runner });
  assert.equal(result.supported, false);
});

test('detectClaudeResumeCliCapability fails closed on an incompatible installed version', () => {
  const runner = (bin, args) => {
    if (args[0] === '--version') return '1.0.0 (Claude Code)\n';
    if (args[0] === '--help') return '  -r, --resume [value]\n  --worktree <name>\n';
    throw new Error('unexpected');
  };
  const result = detectClaudeResumeCliCapability({ claudeBin: 'claude', runner });
  assert.equal(result.supported, false);
});

test('detectClaudeResumeCliCapability fails closed when the CLI binary is unavailable', () => {
  const runner = () => { const error = new Error('spawn claude ENOENT'); error.status = null; throw error; };
  const result = detectClaudeResumeCliCapability({ claudeBin: 'claude', runner });
  assert.equal(result.supported, false);
});

const REPO_ROOT = '/repo';
const WORKTREE_NAME = 'agent-runner-698-41';
const WORKTREE_PATH = `${REPO_ROOT}/.claude/worktrees/${WORKTREE_NAME}`;
const EXPECTED_BRANCH = 'worktree-agent-runner-698-41';
const CAPTURED_HEAD = 'a'.repeat(40);
const CAPTURED_STATUS_FINGERPRINT = fingerprintGitStatus('').statusFingerprint;

function baseHandle(overrides = {}) {
  return {
    worktreeName: WORKTREE_NAME,
    expectedBranch: EXPECTED_BRANCH,
    checkpointHead: CAPTURED_HEAD,
    checkpointStatusFingerprint: CAPTURED_STATUS_FINGERPRINT,
    ...overrides,
  };
}

function worktreeListEntry({ path = WORKTREE_PATH, branch = EXPECTED_BRANCH } = {}) {
  return `worktree ${REPO_ROOT}\nHEAD ${CAPTURED_HEAD}\nbranch refs/heads/main\n\nworktree ${path}\nHEAD ${CAPTURED_HEAD}\nbranch refs/heads/${branch}\n`;
}

/** Runner reporting exactly the captured checkpoint: current == captured. */
function currentGitRunner({
  worktreeList = worktreeListEntry(),
  currentBranch = EXPECTED_BRANCH,
  currentHead = CAPTURED_HEAD,
  statusOutput = '',
} = {}) {
  return (cmd, args, options = {}) => {
    if (args[0] === 'worktree') return worktreeList;
    if (args[0] === 'branch' && args[1] === '--show-current') return `${currentBranch}\n`;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${currentHead}\n`;
    if (args[0] === 'status') return statusOutput;
    throw new Error(`unexpected git call: ${args.join(' ')} (cwd=${options.cwd})`);
  };
}

test('verifyPreservedWorktree confirms an exact, unchanged checkpoint', () => {
  const result = verifyPreservedWorktree({ handle: baseHandle(), repoRoot: REPO_ROOT, runner: currentGitRunner() });
  assert.equal(result.preservedWorktreeCurrent, true);
  assert.equal(result.checkpointCurrent, true);
});

test('verifyPreservedWorktree fails closed when HEAD advanced past the captured checkpoint', () => {
  const result = verifyPreservedWorktree({
    handle: baseHandle(),
    repoRoot: REPO_ROOT,
    runner: currentGitRunner({ currentHead: 'b'.repeat(40) }),
  });
  assert.equal(result.preservedWorktreeCurrent, false);
  assert.equal(result.checkpointCurrent, false);
});

test('verifyPreservedWorktree fails closed when HEAD was rewound behind the captured checkpoint', () => {
  const result = verifyPreservedWorktree({
    handle: baseHandle(),
    repoRoot: REPO_ROOT,
    runner: currentGitRunner({ currentHead: 'c'.repeat(40) }),
  });
  assert.equal(result.preservedWorktreeCurrent, false);
  assert.equal(result.checkpointCurrent, false);
});

test('verifyPreservedWorktree fails closed when the expected branch now points to another commit', () => {
  const differentHead = 'd'.repeat(40);
  const result = verifyPreservedWorktree({
    handle: baseHandle(),
    repoRoot: REPO_ROOT,
    runner: currentGitRunner({
      worktreeList: worktreeListEntry(),
      currentHead: differentHead,
    }),
  });
  assert.equal(result.checkpointCurrent, false);
});

test('verifyPreservedWorktree fails closed when the worktree entry is associated with another branch', () => {
  const result = verifyPreservedWorktree({
    handle: baseHandle(),
    repoRoot: REPO_ROOT,
    runner: currentGitRunner({
      worktreeList: worktreeListEntry({ branch: 'some-other-branch' }),
      currentBranch: 'some-other-branch',
    }),
  });
  assert.equal(result.preservedWorktreeCurrent, false);
  assert.equal(result.checkpointCurrent, false);
});

test('verifyPreservedWorktree fails closed when the working tree became dirty since capture', () => {
  const result = verifyPreservedWorktree({
    handle: baseHandle(),
    repoRoot: REPO_ROOT,
    runner: currentGitRunner({ statusOutput: ' M scripts/ops/claude-runner.mjs\n' }),
  });
  assert.equal(result.preservedWorktreeCurrent, true);
  assert.equal(result.checkpointCurrent, false);
});

test('verifyPreservedWorktree fails closed on both booleans when the handle is missing captured checkpoint fields', () => {
  const result = verifyPreservedWorktree({
    handle: baseHandle({ checkpointHead: undefined }),
    repoRoot: REPO_ROOT,
    runner: currentGitRunner(),
  });
  assert.equal(result.preservedWorktreeCurrent, false);
  assert.equal(result.checkpointCurrent, false);
});

test('verifyPreservedWorktree treats a missing captured status fingerprint as unprovable, not current', () => {
  const result = verifyPreservedWorktree({
    handle: baseHandle({ checkpointStatusFingerprint: undefined }),
    repoRoot: REPO_ROOT,
    runner: currentGitRunner(),
  });
  assert.equal(result.preservedWorktreeCurrent, true);
  assert.equal(result.checkpointCurrent, false);
});

test('verifyPreservedWorktree fails closed when the worktree no longer exists', () => {
  const runner = (cmd, args) => {
    if (args[0] === 'worktree') return `worktree ${REPO_ROOT}\nHEAD ${CAPTURED_HEAD}\nbranch refs/heads/main\n`;
    throw new Error('unexpected');
  };
  const result = verifyPreservedWorktree({ handle: baseHandle(), repoRoot: REPO_ROOT, runner });
  assert.equal(result.preservedWorktreeCurrent, false);
  assert.equal(result.checkpointCurrent, false);
});

test('verifyPreservedWorktree fails closed without a handle or repo root', () => {
  assert.deepEqual(verifyPreservedWorktree({}), { preservedWorktreeCurrent: false, checkpointCurrent: false });
  assert.deepEqual(
    verifyPreservedWorktree({ handle: { worktreeName: 'x', expectedBranch: 'y' } }),
    { preservedWorktreeCurrent: false, checkpointCurrent: false },
  );
});

test('restrictedHandleBindingDigest is deterministic and changes when any bound identity field changes (#698 finding 8)', () => {
  const base = {
    attemptId: 'attempt-1', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    checkpointHead: 'abc123', checkpointStatusFingerprint: 'fp-1',
  };
  const digest = restrictedHandleBindingDigest(base);
  assert.equal(typeof digest, 'string');
  assert.equal(digest.length, 64);
  // Deterministic: identical input produces the identical digest.
  assert.equal(restrictedHandleBindingDigest({ ...base }), digest);

  for (const [field, value] of [
    ['attemptId', 'attempt-2'], ['agent', 'codex'], ['model', 'other-model'], ['harness', 'other-harness'],
    ['checkpointHead', 'def456'], ['checkpointStatusFingerprint', 'fp-2'],
  ]) {
    const changed = restrictedHandleBindingDigest({ ...base, [field]: value });
    assert.notEqual(changed, digest, `changing ${field} must change the digest`);
  }
});
