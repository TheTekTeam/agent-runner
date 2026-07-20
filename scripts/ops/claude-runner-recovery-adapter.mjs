import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fingerprintGitStatus, inspectClaudeCliVersion } from './claude-runner-execution-policy.mjs';

/**
 * Restricted local recovery adapter boundary (#698 finding 2).
 *
 * `native_resume` and `same_agent_continuation` need a Claude session id and
 * a preserved worktree/branch identity to reconnect to. Those references
 * must never reach GitHub comments, the dashboard API, ordinary state
 * summaries, run-result JSON, attention payloads, console output, or error
 * messages — so they are written to a dedicated mode-0700 directory of
 * mode-0600 files, outside every ordinary log/state surface. Ordinary state
 * only ever stores an opaque digest of a handle, never the handle itself.
 */

const RESTRICTED_DIRNAME = '.restricted-recovery';

export function restrictedRecoveryDir(outputDir) {
  return join(outputDir, RESTRICTED_DIRNAME);
}

function restrictedHandleBasename(attemptId) {
  return String(attemptId || '').replace(/[^A-Za-z0-9._:#-]/g, '_');
}

function restrictedHandlePath(outputDir, attemptId) {
  return join(restrictedRecoveryDir(outputDir), `${restrictedHandleBasename(attemptId)}.json`);
}

export function restrictedHandleDigest(handle) {
  if (!handle) return null;
  return createHash('sha256').update(JSON.stringify(handle)).digest('hex');
}

/**
 * A dedicated digest binding the restricted handle's captured checkpoint
 * identity to the *persisted attempt's* agent/model/harness — distinct from
 * `restrictedHandleDigest()`, which only proves the local handle file
 * hasn't been tampered with in isolation. This one is computed once when
 * the handle is captured (from the attempt's identity at that moment) and
 * independently recomputed at revalidation time from the *persisted SQLite
 * row's* identity plus the freshly re-read handle's checkpoint fields — a
 * mismatch means the two durable sources have silently diverged (e.g. the
 * attempt row's agent/model/harness changed, or a handle file was swapped
 * for one captured under a different identity) and must fail closed
 * (#698 finding 8). Persisted in a dedicated `restricted_handle_digest`
 * column, write-once — never overwritable by a later `recordRecoveryAttempt`
 * call, unlike the generic `payload_json` blob, which is wholesale replaced
 * on every write.
 */
export function restrictedHandleBindingDigest({ attemptId, agent, model, harness, checkpointHead, checkpointStatusFingerprint } = {}) {
  const material = JSON.stringify({
    attemptId: String(attemptId || ''),
    agent: String(agent || ''),
    model: String(model || ''),
    harness: String(harness || ''),
    checkpointHead: String(checkpointHead || ''),
    checkpointStatusFingerprint: String(checkpointStatusFingerprint || ''),
  });
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Verify a filesystem path is genuinely owner-exclusive: not a symlink, the
 * exact expected type (directory/regular file), owned by the current
 * process user, and exactly the expected POSIX mode bits. Ambiguous
 * evidence (no `process.getuid`, a non-numeric uid/mode from a non-POSIX
 * filesystem) is treated the same as a violation, never as "probably fine"
 * (#698 finding 3 re-review). `lstat` (not `stat`) is used deliberately so
 * a symlinked path is detected instead of silently followed.
 */
function verifyRestrictedPath(path, { expectedMode, expectDirectory, lstatFn }) {
  let stats;
  try {
    stats = lstatFn(path);
  } catch {
    return { ok: false, missing: true, reason: 'not-found' };
  }
  if (typeof process.getuid !== 'function' || typeof stats.uid !== 'number' || typeof stats.mode !== 'number') {
    return { ok: false, missing: false, reason: 'ambiguous-permission-evidence' };
  }
  if (stats.isSymbolicLink()) return { ok: false, missing: false, reason: 'symlink' };
  if (expectDirectory && !stats.isDirectory()) return { ok: false, missing: false, reason: 'not-a-directory' };
  if (!expectDirectory && !stats.isFile()) return { ok: false, missing: false, reason: 'not-a-regular-file' };
  if (stats.uid !== process.getuid()) return { ok: false, missing: false, reason: 'wrong-owner' };
  if ((stats.mode & 0o777) !== expectedMode) return { ok: false, missing: false, reason: 'wrong-mode' };
  return { ok: true, missing: false, reason: null };
}

/**
 * Persist a recovery resume/continuation handle. Only the caller-supplied
 * `handle` fields are written; callers must never include this return
 * value's `path` in anything logged to GitHub or ordinary state.
 *
 * Writes atomically (temp file + rename on the same directory) and
 * verifies the final directory and file ownership/mode/type before
 * returning — a chmod, write, or rename failure now aborts the write
 * instead of being swallowed as best-effort, and a caller can never end up
 * believing a handle was safely captured when its on-disk permissions
 * don't actually prove that (#698 finding 3 re-review).
 */
export function writeRestrictedRecoveryHandle(outputDir, attemptId, handle, { mkdirFn = mkdirSync, writeFn = writeFileSync, chmodFn = chmodSync, renameFn = renameSync, lstatFn = lstatSync } = {}) {
  const dir = restrictedRecoveryDir(outputDir);
  mkdirFn(dir, { recursive: true, mode: 0o700 });
  chmodFn(dir, 0o700);
  const dirCheck = verifyRestrictedPath(dir, { expectedMode: 0o700, expectDirectory: true, lstatFn });
  if (!dirCheck.ok) throw new Error(`restricted recovery directory failed permission verification: ${dirCheck.reason}`);

  const path = restrictedHandlePath(outputDir, attemptId);
  const tmpPath = join(dir, `.${restrictedHandleBasename(attemptId)}.${randomBytes(8).toString('hex')}.tmp`);
  writeFn(tmpPath, JSON.stringify(handle), { mode: 0o600 });
  chmodFn(tmpPath, 0o600);
  renameFn(tmpPath, path);
  const fileCheck = verifyRestrictedPath(path, { expectedMode: 0o600, expectDirectory: false, lstatFn });
  if (!fileCheck.ok) throw new Error(`restricted recovery handle failed permission verification: ${fileCheck.reason}`);
  return { digest: restrictedHandleDigest(handle) };
}

/**
 * Read a restricted recovery handle back. Fails closed — returns
 * `available:false` — when the file is missing, corrupt, or addressed to a
 * different attempt id. Fails closed with `permissionSafe:false` when the
 * enclosing directory or the file itself is not exactly owner-exclusive
 * (wrong mode, wrong owner, wrong type, a symlink, or ambiguous evidence) —
 * a loosened permission bit must never silently degrade into an ordinary,
 * safe-to-ignore "unavailable" result; callers must check `permissionSafe`
 * explicitly before trusting `available`.
 */
export function readRestrictedRecoveryHandle(outputDir, attemptId, { lstatFn = lstatSync, readFn = readFileSync } = {}) {
  const dir = restrictedRecoveryDir(outputDir);
  const dirCheck = verifyRestrictedPath(dir, { expectedMode: 0o700, expectDirectory: true, lstatFn });
  if (!dirCheck.ok) return { handle: null, digest: null, available: false, permissionSafe: dirCheck.missing };

  const path = restrictedHandlePath(outputDir, attemptId);
  const fileCheck = verifyRestrictedPath(path, { expectedMode: 0o600, expectDirectory: false, lstatFn });
  if (!fileCheck.ok) return { handle: null, digest: null, available: false, permissionSafe: fileCheck.missing };

  let handle;
  try {
    handle = JSON.parse(String(readFn(path, 'utf8')));
  } catch {
    return { handle: null, digest: null, available: false, permissionSafe: true };
  }
  if (!handle || typeof handle !== 'object' || handle.attemptId !== attemptId) {
    return { handle: null, digest: null, available: false, permissionSafe: true };
  }
  return { handle, digest: restrictedHandleDigest(handle), available: true, permissionSafe: true };
}

function runCli(claudeBin, args, runner) {
  try {
    return { status: 0, stdout: String(runner(claudeBin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '') };
  } catch (error) {
    return { status: Number.isInteger(error?.status) ? error.status : 1, stdout: String(error?.stdout || '') };
  }
}

/**
 * Prove the installed Claude CLI documents session-resume support before a
 * `native_resume`/`same_agent_continuation` invocation is ever built.
 * Reuses the same version-inspection helper as the general
 * implementation-CLI gate (`claude-runner-execution-policy.mjs`) and adds a
 * live `--help` check for the specific `--resume`/`--worktree` controls
 * these actions depend on. Never guesses CLI flags from documentation —
 * only from the installed binary's own `--version`/`--help` output.
 */
export function detectClaudeResumeCliCapability({ claudeBin = 'claude', runner = execFileSync } = {}) {
  const version = runCli(claudeBin, ['--version'], runner);
  const help = runCli(claudeBin, ['--help'], runner);
  const versionCheck = inspectClaudeCliVersion(version.stdout, { exitCode: version.status });
  const resumeFlagPresent = /--resume\b|(?:^|\s)-r(?:\s|,)/m.test(help.stdout);
  const worktreeFlagPresent = /--worktree\b/.test(help.stdout);
  return {
    supported: versionCheck.compatible && help.status === 0 && resumeFlagPresent && worktreeFlagPresent,
    installedVersion: versionCheck.installedVersion,
    minimumVersion: versionCheck.minimumVersion,
    resumeFlagPresent,
    worktreeFlagPresent,
  };
}

function runGitText(args, cwd, runner) {
  try {
    return String(runner('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch {
    return null;
  }
}

// Untrimmed variant for `git status` output: claude-runner.mjs's
// captureGitRepositoryEvidence() hashes the raw (untrimmed) stdout when it
// captures a checkpoint fingerprint at the end of an attempt, so this must
// reproduce that exact byte-for-byte input or the two hashes can never
// match even when nothing actually changed.
function runGitRaw(args, cwd, runner) {
  try {
    return String(runner('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

const NOT_CURRENT = Object.freeze({ preservedWorktreeCurrent: false, checkpointCurrent: false });

/**
 * Prove the preserved worktree/branch/checkpoint a resume/continuation
 * handle points at is still *exactly* current — not merely that some
 * worktree with some commit exists (#698 finding 2 re-review). Requires,
 * with no ambiguity tolerated:
 *
 *  - a single `git worktree list --porcelain` entry associating the exact
 *    expected worktree path with the exact expected branch;
 *  - the worktree's actual checked-out branch matches (guards detached HEAD);
 *  - current HEAD equals the handle's captured checkpoint HEAD exactly —
 *    the branch must not have advanced, rewound, or been force-pushed;
 *  - when the handle also captured a status fingerprint, the current
 *    working-tree status fingerprint matches exactly (no new dirty state).
 *
 * A handle missing its captured checkpoint HEAD cannot be verified at all
 * and fails closed on both booleans — "some commit exists" is never
 * accepted as proof of a specific captured checkpoint.
 */
export function verifyPreservedWorktree({ handle, repoRoot, runner = execFileSync } = {}) {
  if (!handle?.worktreeName || !handle?.expectedBranch || !handle?.checkpointHead || !repoRoot) {
    return NOT_CURRENT;
  }

  const worktreePath = join(repoRoot, '.claude', 'worktrees', handle.worktreeName);
  const worktreeList = runGitText(['worktree', 'list', '--porcelain'], repoRoot, runner);
  if (worktreeList === null) return NOT_CURRENT;
  const matchingEntry = worktreeList.split(/\n\s*\n/).find((entry) => entry.includes(`worktree ${worktreePath}`)
    && entry.includes(`branch refs/heads/${handle.expectedBranch}`));
  if (!matchingEntry) return NOT_CURRENT;

  const currentBranch = runGitText(['branch', '--show-current'], worktreePath, runner);
  if (!currentBranch || currentBranch !== handle.expectedBranch) return NOT_CURRENT;

  const currentHead = runGitText(['rev-parse', 'HEAD'], worktreePath, runner);
  if (!currentHead || currentHead !== handle.checkpointHead) return NOT_CURRENT;

  if (!handle.checkpointStatusFingerprint) return { preservedWorktreeCurrent: true, checkpointCurrent: false };
  const statusOutput = runGitRaw(['status', '--porcelain=v1', '--untracked-files=all'], worktreePath, runner);
  if (statusOutput === null) return { preservedWorktreeCurrent: true, checkpointCurrent: false };
  const { statusFingerprint } = fingerprintGitStatus(statusOutput);
  return { preservedWorktreeCurrent: true, checkpointCurrent: statusFingerprint === handle.checkpointStatusFingerprint };
}
