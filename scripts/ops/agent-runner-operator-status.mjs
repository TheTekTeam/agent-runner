#!/usr/bin/env node

// Read-only bounded operator status (issue #67, required by #5 finding
// F10/replacement contract item 9).
//
// State inspection reuses agent-runner-operator-doctor.mjs's
// readOnlyRunnerStateSnapshot() -- a genuinely read-only bounded SQLite
// projection (see that module's header for why buildRunnerDashboard()/
// summarizeRunnerState()/openRunnerStateStore() are not used: their
// writable RunnerStateStore constructor creates directories, opens SQLite
// writable, and runs the full migration path). The derived operator-facing
// shape (activity/metrics/operatorStatus) still reuses the exact canonical,
// already-reviewed PURE functions from claude-runner-dashboard-api.mjs
// (buildRunnerActivity, buildRunnerMetrics, buildRunnerOperatorStatus) --
// those functions only transform already-fetched plain JS data and never
// touch the database themselves, so calling them with data fetched
// read-only is genuine reuse of canonical derivation logic, not a
// reimplementation of it.
//
// Only a narrow, explicitly allowlisted subset of fields is ever forwarded
// in the final report; the raw `queueEvents`/`quota`/`selections`/`claims`
// projections fetched to compute activity/metrics/operatorStatus are used
// only as inputs to those pure functions and are never themselves included
// in output.
//
// The admission circuit-breaker's persisted state is read directly with a
// bounded raw SQL query through the same read-only/immutable SQLite path,
// instead of going through AdmissionCircuitBreaker -- that class's
// constructor unconditionally creates the database file and its tables
// (mkdirSync + CREATE TABLE IF NOT EXISTS) and its check() method can
// DELETE a stale machine_profile row. Neither behavior belongs in a
// command whose entire contract is read-only.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { openReadOnly, readOnlyRunnerStateSnapshot, unitState } from './agent-runner-operator-doctor.mjs';
import { CANDIDATE_PAUSED_EXIT_CODE } from './agent-runner-candidate-admission.mjs';
import { defaultCircuitDbPath, effectiveConfigurationFingerprint } from './agent-runner-circuit-breaker.mjs';
import { loadAgentRunnerConfig, projectIdentity } from './agent-runner-config.mjs';
import { defaultRunnerStateDbPath } from './claude-runner-state.mjs';
import { buildRunnerActivity, buildRunnerMetrics, buildRunnerOperatorStatus } from './claude-runner-dashboard-api.mjs';
import { buildAttentionReconciliationProjection } from './agent-runner-attention-reconciliation.mjs';
import { resolveAttentionReconciliationDbPath } from './agent-runner-attention-reconciliation-path.mjs';
import { readAttentionReconciliationState } from './agent-runner-attention-reconciliation-store.mjs';

export const STATUS_SCHEMA_VERSION = 'agent-runner-operator-status/v1';
export const USAGE_ERROR_EXIT_CODE = 2;
export const SYSTEMIC_ERROR_EXIT_CODE = 1;

function isoNow() {
  return new Date().toISOString();
}

export function parseStatusArgs(argv = [], env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') { index += 1; continue; }
    if (arg.startsWith('--config=')) continue;
    if (arg === '--json') continue;
    return { error: `Unknown argument: ${arg}` };
  }
  return { config };
}

/**
 * Bounded, non-mutating read of the admission circuit-breaker's current
 * state. Mirrors AdmissionCircuitBreaker.check()'s row selection and safe
 * next-action text (agent-runner-circuit-breaker.mjs) without importing its
 * mutating constructor/DELETE branch.
 */
export function readCircuitState(env = process.env) {
  const dbPath = defaultCircuitDbPath(env);
  if (!existsSync(dbPath)) return { blocked: false, exists: false };
  let db;
  try {
    db = openReadOnly(dbPath);
    const row = db.prepare('SELECT * FROM admission_circuit ORDER BY tripped_at LIMIT 1').get();
    if (!row) return { blocked: false, exists: true };
    return {
      blocked: true,
      exists: true,
      scope: row.scope,
      reason: row.reason,
      occurrenceCount: row.occurrence_count,
      trippedAt: row.tripped_at,
      configurationCurrent: row.configuration_fingerprint === effectiveConfigurationFingerprint(env),
      safeNextAction: row.scope === 'machine_profile'
        ? 'Change and verify the effective machine configuration before retrying candidate selection.'
        : 'Repair the systemic runner condition and clear it through a verified healthy pass.',
    };
  } catch {
    return { blocked: false, exists: true, reason: 'circuit-state-unavailable' };
  } finally {
    db?.close();
  }
}

function boundedAttention(projection) {
  return {
    posture: projection.posture,
    counts: projection.counts,
    generation: projection.generation,
    current: projection.items.filter((item) => item.status !== 'historical').slice(0, 10),
  };
}

function boundedNotification(latestNotifications = []) {
  const byStatus = {};
  for (const row of latestNotifications) {
    const key = row.delivery_status || 'unknown';
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  return { countsByDeliveryStatus: byStatus, recent: latestNotifications };
}

export function requiredUnitsInstalled(service, timer) {
  return service?.status === 'installed' && timer?.status === 'installed';
}

export function buildOperatorStatus(config, env = process.env, { now = isoNow, spawn } = {}) {
  const dbPath = env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(config.outputDir || '.var/claude-runner');
  const snapshot = readOnlyRunnerStateSnapshot(dbPath, { historyLimit: 10, includeLatest: true, attentionRepository: config.githubRepo });
  const circuit = readCircuitState(env);
  const service = unitState(config.systemd.serviceName, spawn);
  const timer = unitState(config.systemd.timerName, spawn);
  const generatedAt = now();
  const base = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt,
    project: projectIdentity(config),
    service,
    timer,
    circuit,
    issueMutation: false,
    stateMutation: false,
  };

  if (!snapshot.ok) {
    return {
      ...base,
      ok: false,
      status: snapshot.status,
      reason: snapshot.reason,
      safeNextAction: snapshot.safeNextAction,
      schemaVersionState: null,
    };
  }

  const activity = buildRunnerActivity(snapshot.latest);
  const metrics = buildRunnerMetrics({ latest: snapshot.latest });
  const reconciliationDbPath = resolveAttentionReconciliationDbPath({ env, config });
  const attentionState = config.githubRepo
    ? readAttentionReconciliationState(reconciliationDbPath, config.githubRepo)
    : null;
  const attentionProjection = buildAttentionReconciliationProjection(
    snapshot.attentionSource?.attentionEvents || [], snapshot.attentionSource?.recoveryAttempts || [], attentionState,
    { repository: config.githubRepo, now: generatedAt, sourceTotal: snapshot.attentionSource?.total, sourceOverflow: snapshot.attentionSource?.overflow },
  );
  const operatorStatus = buildRunnerOperatorStatus(snapshot.latest, activity, snapshot.currentHealthConditions, attentionProjection);

  return {
    ...base,
    ok: true,
    status: snapshot.status,
    schemaVersionState: snapshot.schemaVersion,
    operatorStatus,
    health: snapshot.currentHealthConditions,
    currentTask: activity,
    queue: metrics.queue,
    attention: boundedAttention(attentionProjection),
    notification: boundedNotification(snapshot.latest.notifications),
  };
}

export function exitCodeForStatus(report) {
  if (!report.ok) return SYSTEMIC_ERROR_EXIT_CODE;
  if (!requiredUnitsInstalled(report.service, report.timer)) return SYSTEMIC_ERROR_EXIT_CODE;
  if (report.operatorStatus?.code === 'global_systemic_pause') return SYSTEMIC_ERROR_EXIT_CODE;
  if (report.circuit?.blocked) return CANDIDATE_PAUSED_EXIT_CODE;
  return 0;
}

export function run(argv = [], env = process.env, io = { stdout: process.stdout, stderr: process.stderr }, dependencies = {}) {
  let args;
  try {
    args = parseStatusArgs(argv, env);
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
    report = buildOperatorStatus(args.config, env, dependencies);
  } catch {
    io.stdout.write(`${JSON.stringify({ ok: false, reason: 'status-internal-error' }, null, 2)}\n`);
    return SYSTEMIC_ERROR_EXIT_CODE;
  }
  io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCodeForStatus(report);
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  return run(argv, env, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: 'status-internal-error' })}\n`);
    process.exitCode = SYSTEMIC_ERROR_EXIT_CODE;
  });
}
