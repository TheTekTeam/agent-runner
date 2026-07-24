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
// exists. Instead this opens the database with node:sqlite's DatabaseSync
// via a `file:...?mode=ro&immutable=1` URI, which SQLite guarantees never
// creates a directory, database file, WAL/SHM file, table, index, or
// schema row -- `immutable=1` additionally skips the WAL-index (-shm) file
// that a plain `mode=ro` connection still creates to coordinate with a
// concurrently-written WAL-mode database (verified empirically: a bare
// `mode=ro` open of a live WAL database creates -shm/-wal; `immutable=1`
// does not). The tradeoff, made deliberately: SQLite makes no promise about
// what an immutable connection sees if the file changes underneath it
// mid-read; for a short-lived, single-pass diagnostic snapshot against a
// database that is at most append/update-only between commits, this is an
// acceptable point-in-time read, not a hard consistency requirement.
//
// Every table and column read is drawn from a fixed local allowlist (never
// `SELECT *`), and every SQL-side limit is bounded before use.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { admitMachineProfile } from './agent-runner-admission.mjs';
import { resolveAgentForLabels } from './agent-runner-agents.mjs';
import { getAgentSettings } from './agent-runner-agent-settings.mjs';
import { CANDIDATE_PAUSED_EXIT_CODE } from './agent-runner-candidate-admission.mjs';
import { loadAgentRunnerConfig, projectIdentity } from './agent-runner-config.mjs';
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

/**
 * Shared by agent-runner-operator-status.mjs for its own SQLite reads (the
 * admission circuit-breaker database) so every read-only SQLite open in
 * this operator CLI goes through the same immutable-URI path -- see the
 * module header for why immutable=1 is required, not just mode=ro.
 */
export function openReadOnly(dbPath) {
  const url = pathToFileURL(resolvePath(dbPath));
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  return new DatabaseSync(url.href, { readOnly: true });
}

function fetchLatest(db, table, columns, limit) {
  return db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY id DESC LIMIT ?`).all(limit);
}

function extractPayloadReason(payloadJson) {
  try {
    const parsed = JSON.parse(payloadJson || '{}');
    return typeof parsed?.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}

function fetchQueueEvents(db, limit) {
  const rows = db.prepare(`SELECT ${QUEUE_EVENTS_COLUMNS.join(', ')}, payload_json FROM queue_events ORDER BY id DESC LIMIT ?`).all(limit);
  return rows.map((row) => {
    const { payload_json: payloadJson, ...rest } = row;
    return { ...rest, payload: { reason: extractPayloadReason(payloadJson) } };
  });
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
export function readOnlyRunnerStateSnapshot(dbPath, { historyLimit = 10, includeLatest = false } = {}) {
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

    let latest = null;
    if (includeLatest) {
      const limit = clampLimit(historyLimit);
      latest = {
        runResults: fetchLatest(db, 'run_results', RUN_RESULTS_COLUMNS, limit),
        attentionEvents: fetchLatest(db, 'attention_events', ATTENTION_EVENTS_COLUMNS, limit),
        notifications: fetchLatest(db, 'notification_events', NOTIFICATION_EVENTS_COLUMNS, limit),
        claims: fetchLatest(db, 'claims', CLAIMS_COLUMNS, limit),
        selections: fetchLatest(db, 'issue_selections', ISSUE_SELECTIONS_COLUMNS, limit),
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
