#!/usr/bin/env node

// Read-only operator doctor report (issue #67, required by #5 finding F10).
// Reuses existing canonical modules only: agent-runner-config.mjs for
// project identity, agent-runner-admission.mjs for machine admission,
// agent-runner-agent-settings.mjs/agent-runner-agents.mjs for adapter
// state, and the table list exported from claude-runner-state.mjs. It never
// mutates GitHub, SQLite or systemd.
//
// State inspection (readOnlyRunnerStateSnapshot(), below) is a genuinely
// read-only bounded projection, shared with agent-runner-operator-status.mjs.
// It deliberately does NOT use claude-runner-dashboard-api.mjs's
// buildRunnerDashboard()/summarizeRunnerState() or
// claude-runner-state.mjs's openRunnerStateStore(): RunnerStateStore's
// constructor unconditionally creates the parent directory, opens SQLite
// writable, and runs its full migration path (PRAGMA journal_mode=WAL,
// CREATE TABLE/schema-version writes) even when every table already
// exists.
//
// Two SQLite realities must both be honored against the *live* runner state
// database, which is a WAL-mode file that is genuinely being written to
// concurrently by the runner service:
//   1. `immutable=1` tells SQLite the file will never change for the life of
//      the connection, and SQLite trusts that promise -- it skips locking
//      and change detection entirely. Asserting that against a database that
//      really is changing underneath the connection is simply false, and can
//      hand back an inconsistent read spanning two different WAL states.
//   2. A bare `mode=ro` connection is honest about mutability, but WAL mode
//      requires a reader to create/open a `-shm` (and sometimes `-wal`)
//      sidecar file next to the database purely to coordinate with
//      concurrent writers -- a side effect this command must never have on
//      the live state directory.
//
// The fix used here reconciles both by taking one of two SQLite-defined
// snapshot paths, chosen by whether the live `-wal` sidecar currently
// exists -- i.e. whether WAL machinery is actually active against the
// source right now:
//
//   * If `-wal` exists, a writer may commit concurrently at any moment, so
//     `snapshotSourceForReadOnly()` uses SQLite's own Online Backup API
//     (`node:sqlite`'s `backup()`, https://sqlite.org/backup.html) to page-
//     copy the live database into a private temp file. The backup API is
//     SQLite's purpose-built mechanism for exactly this: reading a
//     consistent snapshot of a database while other connections keep
//     writing to it, automatically restarting the copy if a concurrent
//     writer commits mid-backup, rather than trusting an ordinary
//     byte-level file copy to not race a writer. Because `-wal` already
//     exists, opening a read-only connection against the live path touches
//     only files a concurrent writer already created -- it creates nothing
//     new in the live state directory. `backup()` is asynchronous, so it
//     runs in a short-lived child process (`spawnSync`, the same primitive
//     already used for git/systemctl inspection in this file) so every
//     exported function here stays synchronous.
//   * If `-wal` does not exist, no writer can be mid-transaction: in WAL
//     mode, a writer must create/open `-wal` before it writes anything, so
//     the main database file is provably quiescent for as long as `-wal`
//     stays absent. In that state a plain `copyFileSync` of the main file
//     alone is copying an immobile file, verified by re-checking that
//     `-wal` still doesn't exist and the file's stat(size, mtime) is
//     unchanged once the copy completes, retrying a bounded number of
//     times and failing closed if a writer starts mid-copy.
//
// Either way, the live state directory is only ever read from, never
// written to, and the private temp files genuinely cannot change
// underneath the connection once produced -- nothing else has a path to
// them -- so opening that private copy with `mode=ro&immutable=1` is an
// honest assertion, not a false one, and any WAL sidecar SQLite creates
// while reading it lives only in the temp directory, removed on close().
//
// Every table and column read is drawn from a fixed local allowlist (never
// `SELECT *`), and every SQL-side limit is bounded before use.

import {
  copyFileSync, existsSync, mkdtempSync, rmSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, join as joinPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { admitMachineProfile } from './agent-runner-admission.mjs';
import { resolveAgentForLabels } from './agent-runner-agents.mjs';
import { getAgentSettings } from './agent-runner-agent-settings.mjs';
import { CANDIDATE_PAUSED_EXIT_CODE } from './agent-runner-candidate-admission.mjs';
import { loadAgentRunnerConfig, projectIdentity } from './agent-runner-config.mjs';
// #97: the same bounded assignment-evidence guards the dashboard projection
// uses, so an assignment label/agent id is validated once, in one place,
// rather than being re-checked (and possibly re-interpreted) per reader.
import { boundedAgentId, boundedAssignmentLabel } from './claude-runner-dashboard-api.mjs';
import { RUNNER_STATE_TABLES } from './claude-runner-state.mjs';

export const DOCTOR_SCHEMA_VERSION = 'agent-runner-operator-doctor/v1';
export const USAGE_ERROR_EXIT_CODE = 2;
export const SYSTEMIC_ERROR_EXIT_CODE = 1;

// Single fixed message for every state-DB-unusable case (missing,
// unreadable, structurally incomplete, or an invalid path). Deliberately
// one closed string, not per-case prose: the packet requires "a fixed
// reason, safe next action", and this must never be, or be confused with,
// "No action required".
export const STATE_UNAVAILABLE_SAFE_NEXT_ACTION = 'Provision, restore or repair the runner state database before continuing; this command never creates or modifies it.';
const REQUIRED_UNIT_SAFE_NEXT_ACTION = 'Install the configured service/timer units on this host before continuing; this command never installs or modifies them.';

function isoNow() {
  return new Date().toISOString();
}

export function parseDoctorArgs(argv = [], env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  const args = { project: null, config };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') { index += 1; continue; }
    if (arg.startsWith('--config=')) continue;
    if (arg === '--project') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { error: '--project requires a value' };
      args.project = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--project=')) { args.project = arg.slice('--project='.length); continue; }
    return { error: `Unknown argument: ${arg}` };
  }
  if (!args.project) return { error: '--project is required' };
  if (args.project !== config.projectId) return { error: 'project-identity-mismatch' };
  return args;
}

// ---------------------------------------------------------------------
// systemd unit inspection: bounded LoadState/ActiveState/UnitFileState.
// ---------------------------------------------------------------------

const UNIT_PROPERTIES = 'LoadState,ActiveState,UnitFileState';

/**
 * Distinguishes three cases a boolean is-active/is-enabled check collapses
 * together: a unit that is installed (loaded) but inactive/disabled -- a
 * healthy pre-acceptance-gate state today -- a unit that is genuinely
 * not-found, and inspection that could not run at all (systemctl missing,
 * `--user` bus unreachable, or any other spawn/exit failure). LoadState,
 * ActiveState and UnitFileState are systemd's own fixed vocabulary
 * (loaded/not-found/masked/error; active/inactive/failed/...;
 * enabled/disabled/static/masked/...), never free text, so passing them
 * through verbatim is safe.
 */
export function inspectUnit(unit, spawn = spawnSync) {
  const result = spawn('systemctl', ['--user', 'show', unit, `--property=${UNIT_PROPERTIES}`, '--value'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return {
      name: unit, status: 'unavailable', loadState: null, activeState: null, unitFileState: null,
    };
  }
  const [loadState, activeState, unitFileState] = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim());
  if (!loadState) {
    return {
      name: unit, status: 'unavailable', loadState: null, activeState: null, unitFileState: null,
    };
  }
  return {
    name: unit,
    status: loadState === 'not-found' ? 'not-found' : 'installed',
    loadState,
    activeState: activeState || null,
    unitFileState: unitFileState || null,
  };
}

// Kept as the previous export name so agent-runner-operator-status.mjs's
// existing import continues to resolve; now backed by inspectUnit(). The
// optional `spawn` override exists purely so tests can simulate
// installed/not-found/unavailable systemd responses deterministically,
// without depending on the host's actual systemd state.
export function unitState(unit, spawn = spawnSync) {
  return inspectUnit(unit, spawn);
}

// ---------------------------------------------------------------------
// checkout cleanliness: tracked + untracked, bounded counts only.
// ---------------------------------------------------------------------

function runGitReadOnly(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) return { ok: false };
  return { ok: true, stdout: String(result.stdout || '') };
}

export function inspectCheckout(localRepoPath) {
  if (!localRepoPath || !existsSync(localRepoPath)) {
    return { present: false, clean: null, changedFileCount: null, headShortSha: null, reason: 'checkout-missing' };
  }
  const isWorkTree = runGitReadOnly(['rev-parse', '--is-inside-work-tree'], localRepoPath);
  if (!isWorkTree.ok || isWorkTree.stdout.trim() !== 'true') {
    return { present: true, clean: null, changedFileCount: null, headShortSha: null, reason: 'checkout-not-a-git-worktree' };
  }
  // --untracked-files=all (not the default "normal", which collapses an
  // untracked directory into one line): every untracked file must be able
  // to flip clean=false, matching an ordinary `git status` an operator
  // would run by hand. Only the line COUNT is ever read below -- the
  // listed paths themselves are discarded, never included in output.
  const status = runGitReadOnly(['status', '--porcelain=v1', '--untracked-files=all'], localRepoPath);
  const head = runGitReadOnly(['rev-parse', '--short=12', 'HEAD'], localRepoPath);
  if (!status.ok || !head.ok) {
    return { present: true, clean: null, changedFileCount: null, headShortSha: null, reason: 'checkout-inspection-failed' };
  }
  const changedLines = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    present: true,
    clean: changedLines.length === 0,
    changedFileCount: changedLines.length,
    headShortSha: head.stdout.trim() || null,
    reason: null,
  };
}

// ---------------------------------------------------------------------
// Genuinely read-only runner state snapshot, shared with
// agent-runner-operator-status.mjs.
// ---------------------------------------------------------------------

const HISTORY_TABLES = RUNNER_STATE_TABLES.filter((table) => table !== 'runner_state_schema');

const RUN_RESULTS_COLUMNS = ['id', 'created_at', 'started_at', 'finished_at', 'repo', 'issue_number', 'mode', 'exit_code', 'signal'];
const ATTENTION_EVENTS_COLUMNS = ['id', 'created_at', 'updated_at', 'repo', 'project', 'issue_number', 'attempt_id', 'reason', 'agent', 'started_at', 'finished_at', 'recovery_status', 'next_action', 'dashboard_reference', 'policy_revision', 'notification_count', 'last_notification_at', 'resolved_at'];
const ATTENTION_SOURCE_COLUMNS = ['id', 'dedupe_key', 'updated_at', 'repo', 'issue_number', 'attempt_id', 'reason', 'recovery_status', 'next_action', 'policy_revision', 'resolved_at', 'event_json'];
const ATTENTION_ATTEMPT_COLUMNS = ['attempt_id', 'repo', 'outcome', 'finished_at', 'attention_status', 'attention_dedupe_key', 'resolution_state'];
const HEALTH_CONDITIONS_COLUMNS = ['id', 'repo', 'condition_type', 'reason', 'opened_at', 'updated_at', 'resolved_at', 'safe_next_action'];
const NOTIFICATION_EVENTS_COLUMNS = ['id', 'created_at', 'updated_at', 'repo', 'project', 'issue_number', 'event_type', 'reason_code', 'agent', 'delivery_status', 'attempt_count', 'max_attempts', 'stale_recovery_count', 'next_attempt_at', 'last_attempt_at', 'delivered_at', 'resolved_at'];
const CLAIMS_COLUMNS = ['id', 'created_at', 'repo', 'issue_number', 'action', 'status_label', 'selection_mode'];
const ISSUE_SELECTIONS_COLUMNS = ['id', 'created_at', 'repo', 'issue_number', 'status_label', 'selection_mode'];
const QUOTA_HISTORY_COLUMNS = ['id', 'created_at', 'blocked', 'session_usage_percent', 'weekly_usage_percent'];
const QUEUE_EVENTS_COLUMNS = ['id', 'created_at', 'repo', 'event_type', 'issue_number', 'status_label', 'reason'];

function clampLimit(limit, fallback = 10) {
  if (!Number.isInteger(limit) || limit < 1) return fallback;
  return Math.min(limit, 50);
}

const SNAPSHOT_MAX_ATTEMPTS = 5;
const SNAPSHOT_BACKUP_TIMEOUT_MS = 30000;

function statOrNull(path) {
  try {
    const info = statSync(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

function sameStat(left, right) {
  if (left === null || right === null) return left === right;
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

// Runs in a short-lived child process (module header explains why): opens
// the live database read-only -- safe here because the caller only takes
// this path when `-wal` already exists, so no file this creates is new to
// the live directory -- and hands it to node:sqlite's backup(), which reads
// SQLite's Online Backup API to page-copy a consistent snapshot into
// `destPath`, transparently restarting if a concurrent writer commits
// mid-copy.
const ONLINE_BACKUP_CHILD_SCRIPT = `
import { existsSync } from 'node:fs';
import * as sqlite from 'node:sqlite';
const [srcPath, destPath] = process.argv.slice(1);
const source = new sqlite.DatabaseSync(srcPath, { readOnly: true });
try {
  // Opening DatabaseSync itself does not access WAL pages. Re-check both
  // coordination files after the handle is open and before backup() performs
  // the first database read. If either vanished during dispatch, fail closed
  // rather than giving SQLite permission to create a missing live sidecar.
  if (!existsSync(srcPath + '-wal') || !existsSync(srcPath + '-shm')) {
    throw new Error('live-wal-coordination-missing');
  }
  await sqlite.backup(source, destPath);
} finally {
  source.close();
}
`;

/**
 * Performs the Online Backup API copy (see module header) in a child
 * process so this stays synchronous, since node:sqlite's backup() is
 * promise-based. Returns whether the destination file was produced.
 */
function backupLiveDatabaseViaOnlineBackup(resolvedPath, tempDbPath, spawn) {
  const result = spawn(
    process.execPath,
    ['--input-type=module', '--no-warnings', '-e', ONLINE_BACKUP_CHILD_SCRIPT, '--', resolvedPath, tempDbPath],
    { encoding: 'utf8', timeout: SNAPSHOT_BACKUP_TIMEOUT_MS },
  );
  return result.status === 0 && existsSync(tempDbPath);
}

/**
 * Produces a private, caller-owned temp-directory copy of the live
 * database that is genuinely internally consistent even though the source
 * may be written to concurrently -- see the module header for the two
 * SQLite-defined mechanisms chosen between (Online Backup API vs. a
 * WAL-absence-provable quiescent copy) and why. Retries a bounded number
 * of times and throws (fails closed) if a coherent snapshot is never
 * obtained. Returns the temp directory path and the path to the snapshot
 * database file; the caller owns cleanup.
 */
function snapshotSourceForReadOnly(dbPath, { spawn = spawnSync } = {}) {
  const resolvedPath = resolvePath(dbPath);
  const walPath = `${resolvedPath}-wal`;
  const shmPath = `${resolvedPath}-shm`;
  for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    const tempDir = mkdtempSync(joinPath(tmpdir(), 'agent-runner-state-snapshot-'));
    const tempDbPath = joinPath(tempDir, 'state.sqlite');
    try {
      const walExists = existsSync(walPath);
      const shmExists = existsSync(shmPath);
      if (walExists || shmExists) {
        // Read-only WAL access is allowed to rely on pre-existing
        // coordination files, but this command must never create a missing
        // counterpart. An incomplete/transient pair therefore fails this
        // attempt closed and is retried.
        if (walExists && shmExists
          && backupLiveDatabaseViaOnlineBackup(resolvedPath, tempDbPath, spawn)) {
          return { tempDir, tempDbPath };
        }
      } else {
        const before = statOrNull(resolvedPath);
        copyFileSync(resolvedPath, tempDbPath);
        const after = statOrNull(resolvedPath);
        // A writer can only ever begin modifying the source by first
        // creating WAL coordination state (module header): re-checking that
        // BOTH coordination files remain absent here, alongside the
        // unchanged main-file stat, keeps this branch bounded to the
        // quiescent main-file case. It never copies a live WAL.
        if (!existsSync(walPath) && !existsSync(shmPath) && sameStat(before, after)) {
          return { tempDir, tempDbPath };
        }
      }
    } catch {
      // Source disappeared, a sidecar appeared/vanished mid-copy, or the
      // backup child process failed: treat exactly like a detected race
      // below and retry.
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
  throw new Error('state-db-snapshot-unstable');
}

/**
 * Shared by agent-runner-operator-status.mjs for its own SQLite reads (the
 * admission circuit-breaker database) so every read-only SQLite open in
 * this operator CLI goes through the same private-snapshot path -- see the
 * module header for why a bare `mode=ro&immutable=1` open of the *live*
 * database is unsafe, and why copying first makes that assertion honest.
 * Returns a DatabaseSync-shaped handle: `prepare()` unchanged, `close()`
 * additionally removes the private temp directory.
 */
export function openReadOnly(dbPath) {
  const { tempDir, tempDbPath } = snapshotSourceForReadOnly(dbPath);
  let db;
  try {
    const url = pathToFileURL(tempDbPath);
    url.searchParams.set('mode', 'ro');
    url.searchParams.set('immutable', '1');
    db = new DatabaseSync(url.href, { readOnly: true });
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    prepare: (...args) => db.prepare(...args),
    close: () => {
      try {
        db.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}

function fetchLatest(db, table, columns, limit) {
  return db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY id DESC LIMIT ?`).all(limit);
}

/**
 * Current-task truth must never depend on two independently truncated
 * history windows coinciding (#172): a claim's terminal `run_results` row
 * can legitimately fall outside the bounded `historyLimit` window used for
 * presentation. For every distinct (repo, issue_number) pair among the
 * bounded candidate claims, this runs one direct, unbounded, repo-and-issue
 * scoped query for that issue's single latest run result and merges it into
 * the presentation-bounded `run_results` rows (deduped by id) before
 * current-task correlation runs. The set of *candidate claims* stays
 * bounded (a reasonable presentation-layer limit, not the defect); what
 * changes is that whether a given candidate claim has a later terminal
 * result is now answered authoritatively, not by coincidence of two
 * unrelated LIMIT clauses.
 */
function fetchAuthoritativeTerminalResults(db, claims) {
  const stmt = db.prepare(`SELECT ${RUN_RESULTS_COLUMNS.join(', ')} FROM run_results WHERE repo = ? AND issue_number = ? ORDER BY id DESC LIMIT 1`);
  const seen = new Set();
  const rows = [];
  for (const claim of claims) {
    if (typeof claim.repo !== 'string' || !Number.isInteger(claim.issue_number)) continue;
    const key = `${claim.repo} ${claim.issue_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = stmt.get(claim.repo, claim.issue_number);
    if (row) rows.push(row);
  }
  return rows;
}

function mergeRunResultsById(bounded, authoritative) {
  const byId = new Map(bounded.map((row) => [row.id, row]));
  for (const row of authoritative) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()].sort((left, right) => right.id - left.id);
}

function extractPayloadReason(payloadJson) {
  try {
    const parsed = JSON.parse(payloadJson || '{}');
    return typeof parsed?.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}

/**
 * `issue_selections.payload_json` holds the scheduler's whole selection plan
 * (skip evidence, comment identities, state paths). Only the two bounded
 * assignment-evidence fields are projected out of it (#97), in the same
 * positive-allowlist style as `extractPayloadReason()` above: the shared
 * assignment label so operator status can display `Codex / Claude`, and the
 * actual selected agent id so that display can never stand in for the worker
 * that ran. Anything the catalogue does not recognise fails closed to null.
 */
function extractAssignmentEvidence(payloadJson) {
  try {
    const parsed = JSON.parse(payloadJson || '{}');
    const agent = parsed?.agent && typeof parsed.agent === 'object' ? parsed.agent : {};
    return {
      agent: {
        agentId: boundedAgentId(agent.agentId),
        assignmentLabel: boundedAssignmentLabel(agent.assignmentLabel),
      },
    };
  } catch {
    return { agent: { agentId: null, assignmentLabel: null } };
  }
}

function fetchIssueSelections(db, limit) {
  const rows = db.prepare(`SELECT ${ISSUE_SELECTIONS_COLUMNS.join(', ')}, payload_json FROM issue_selections ORDER BY id DESC LIMIT ?`).all(limit);
  return rows.map((row) => {
    const { payload_json: payloadJson, ...rest } = row;
    return { ...rest, payload: extractAssignmentEvidence(payloadJson) };
  });
}

function fetchQueueEvents(db, limit) {
  const rows = db.prepare(`SELECT ${QUEUE_EVENTS_COLUMNS.join(', ')}, payload_json FROM queue_events ORDER BY id DESC LIMIT ?`).all(limit);
  return rows.map((row) => {
    const { payload_json: payloadJson, ...rest } = row;
    return { ...rest, payload: { reason: extractPayloadReason(payloadJson) } };
  });
}

function fetchAttentionReconciliationSource(db, repository) {
  if (typeof repository !== 'string' || !repository) return null;
  const total = db.prepare('SELECT COUNT(*) AS total FROM attention_events WHERE repo = ? AND resolved_at IS NULL').get(repository)?.total ?? 0;
  const attentionEvents = db.prepare(`SELECT ${ATTENTION_SOURCE_COLUMNS.join(', ')} FROM attention_events
    WHERE repo = ? AND resolved_at IS NULL ORDER BY id ASC LIMIT 201`).all(repository);
  const attemptIds = [...new Set(attentionEvents.map((row) => row.attempt_id).filter(Boolean))];
  const recoveryAttempts = attemptIds.length === 0 ? [] : db.prepare(`SELECT ${ATTENTION_ATTEMPT_COLUMNS.join(', ')}
    FROM recovery_attempts WHERE repo = ? AND attempt_id IN (${attemptIds.map(() => '?').join(',')})`).all(repository, ...attemptIds);
  return { attentionEvents, recoveryAttempts, total, overflow: total > 200 };
}

function unavailableSnapshot(status, reason) {
  return {
    ok: false,
    status,
    reason,
    safeNextAction: STATE_UNAVAILABLE_SAFE_NEXT_ACTION,
    schemaVersion: null,
    counts: null,
    currentHealthConditions: null,
    latest: null,
    attentionSource: null,
  };
}

/**
 * Genuinely read-only runner state inspection. Returns a closed failure
 * shape (see unavailableSnapshot()) for a missing path, a missing file, a
 * database that cannot be opened/queried, or one missing any table this
 * schema requires -- never partial/best-effort success. `includeLatest`
 * additionally fetches bounded latest-N allowlisted rows per table plus
 * current (unresolved) health conditions, for agent-runner-operator-status.mjs.
 */
export function readOnlyRunnerStateSnapshot(dbPath, { historyLimit = 10, includeLatest = false, attentionRepository = null } = {}) {
  if (!dbPath || typeof dbPath !== 'string') {
    return unavailableSnapshot('invalid-path', 'state-db-path-invalid');
  }
  if (!existsSync(dbPath)) {
    return unavailableSnapshot('missing', 'state-db-missing');
  }

  let db;
  try {
    db = openReadOnly(dbPath);
    const existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    );
    const missingTables = RUNNER_STATE_TABLES.filter((table) => !existingTables.has(table));
    if (missingTables.length > 0) {
      return unavailableSnapshot('incomplete', 'state-db-schema-incomplete');
    }
    const schemaRow = db.prepare('SELECT version FROM runner_state_schema ORDER BY version DESC LIMIT 1').get();
    if (!schemaRow || !Number.isInteger(schemaRow.version)) {
      return unavailableSnapshot('incomplete', 'state-db-schema-incomplete');
    }

    const counts = Object.fromEntries(
      HISTORY_TABLES.map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]),
    );
    const currentHealthConditions = db
      .prepare(`SELECT ${HEALTH_CONDITIONS_COLUMNS.join(', ')} FROM runner_health_conditions WHERE resolved_at IS NULL ORDER BY opened_at LIMIT ?`)
      .all(clampLimit(50, 50));
    const attentionSource = fetchAttentionReconciliationSource(db, attentionRepository);

    let latest = null;
    if (includeLatest) {
      const limit = clampLimit(historyLimit);
      const claims = fetchLatest(db, 'claims', CLAIMS_COLUMNS, limit);
      const boundedRunResults = fetchLatest(db, 'run_results', RUN_RESULTS_COLUMNS, limit);
      latest = {
        runResults: mergeRunResultsById(boundedRunResults, fetchAuthoritativeTerminalResults(db, claims)),
        attentionEvents: fetchLatest(db, 'attention_events', ATTENTION_EVENTS_COLUMNS, limit),
        notifications: fetchLatest(db, 'notification_events', NOTIFICATION_EVENTS_COLUMNS, limit),
        claims,
        selections: fetchIssueSelections(db, limit),
        queueEvents: fetchQueueEvents(db, limit),
        quota: fetchLatest(db, 'quota_history', QUOTA_HISTORY_COLUMNS, limit),
      };
    }

    return {
      ok: true,
      status: 'ok',
      reason: null,
      safeNextAction: null,
      schemaVersion: schemaRow.version,
      counts,
      currentHealthConditions,
      latest,
      attentionSource,
    };
  } catch {
    return unavailableSnapshot('error', 'state-db-unreadable');
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------
// doctor report assembly
// ---------------------------------------------------------------------

function adapterState(config, env) {
  const agentIds = new Set();
  for (const label of config.acceptedAgentLabels) {
    const agent = resolveAgentForLabels([label]);
    if (agent?.agentId) agentIds.add(agent.agentId);
  }
  return [...agentIds].sort().map((agentId) => {
    const settings = getAgentSettings({ agentId, env });
    return {
      agentId,
      fileFound: settings.fileFound,
      routable: settings.routable,
      reason: settings.reason,
    };
  });
}

function requiredUnitsInstalled(service, timer) {
  return service.status === 'installed' && timer.status === 'installed';
}

function computeSafeNextAction({
  checkout, state, service, timer, admission, adapters,
}) {
  if (!checkout.present || checkout.reason) {
    return 'Provision or repair the configured local repository checkout before continuing.';
  }
  if (!state.ok) {
    return state.safeNextAction;
  }
  if (!requiredUnitsInstalled(service, timer)) {
    return REQUIRED_UNIT_SAFE_NEXT_ACTION;
  }
  if (!admission.allowed) {
    return admission.safeNextAction;
  }
  if (adapters.length > 0 && !adapters.some((adapter) => adapter.routable)) {
    return 'Configure and enable at least one accepted agent in the machine-local agent-settings.json.';
  }
  return 'No action required; all inspected systems are healthy.';
}

export function buildDoctorReport(args, env = process.env, { now = isoNow, spawn = spawnSync } = {}) {
  const config = args.config;
  const checkout = inspectCheckout(config.localRepoPath);
  const snapshot = readOnlyRunnerStateSnapshot(config.stateDbPath, { includeLatest: false });
  const state = {
    ok: snapshot.ok,
    status: snapshot.status,
    reason: snapshot.reason,
    safeNextAction: snapshot.safeNextAction,
    schemaVersion: snapshot.schemaVersion,
    counts: snapshot.counts,
  };
  // Doctor always evaluates the real machine admission profile (opt-in,
  // approver allowlist), not merely "would this specific invocation have
  // requested execution" -- admitMachineProfile() is a pure computation
  // over env/argv with no side effects regardless of this flag, so forcing
  // it does not execute or claim anything.
  const admission = admitMachineProfile({ argv: ['--execute'], env });
  const adapters = adapterState(config, env);
  const service = inspectUnit(config.systemd.serviceName, spawn);
  const timer = inspectUnit(config.systemd.timerName, spawn);

  const report = {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt: now(),
    project: projectIdentity(config),
    checkout,
    service,
    timer,
    state,
    adapters,
    admission: {
      allowed: admission.allowed,
      scope: admission.scope,
      reason: admission.reason,
      configurationFingerprint: admission.configurationFingerprint,
    },
    issueMutation: false,
    stateMutation: false,
  };
  report.safeNextAction = computeSafeNextAction({
    checkout, state, service, timer, admission, adapters,
  });
  return report;
}

export function exitCodeForDoctorReport(report) {
  if (!report.state.ok) return SYSTEMIC_ERROR_EXIT_CODE;
  if (!requiredUnitsInstalled(report.service, report.timer)) return SYSTEMIC_ERROR_EXIT_CODE;
  if (!report.admission.allowed && report.admission.scope === 'machine_profile') return CANDIDATE_PAUSED_EXIT_CODE;
  return 0;
}

export function run(argv = [], env = process.env, io = { stdout: process.stdout, stderr: process.stderr }, dependencies = {}) {
  let args;
  try {
    args = parseDoctorArgs(argv, env);
  } catch {
    // loadAgentRunnerConfig() throws (rather than returning a parse
    // result) on an unreadable/malformed --config file, embedding the
    // resolved local path and a raw fs error message. Fail closed with a
    // typed reason instead of letting that escape.
    io.stderr.write(`${JSON.stringify({ ok: false, reason: 'config-load-failed' })}\n`);
    return USAGE_ERROR_EXIT_CODE;
  }
  if (args.error) {
    io.stderr.write(`${JSON.stringify({ ok: false, reason: args.error })}\n`);
    return USAGE_ERROR_EXIT_CODE;
  }
  let report;
  try {
    report = buildDoctorReport(args, env, dependencies);
  } catch {
    io.stdout.write(`${JSON.stringify({ ok: false, reason: 'doctor-internal-error' }, null, 2)}\n`);
    return SYSTEMIC_ERROR_EXIT_CODE;
  }
  io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCodeForDoctorReport(report);
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  return run(argv, env, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: 'doctor-internal-error' })}\n`);
    process.exitCode = SYSTEMIC_ERROR_EXIT_CODE;
  });
}
