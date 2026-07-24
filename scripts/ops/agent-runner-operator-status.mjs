#!/usr/bin/env node

// Read-only bounded operator status (issue #67, required by #5 finding
// F10/replacement contract item 9). Reuses claude-runner-dashboard-api.mjs's
// buildRunnerDashboard() for health/activity/metrics/notification state
// (already positive-allowlisted internally -- see TABLE_SERIALIZERS in that
// module) and agent-runner-operator-doctor.mjs's unitState() for
// service/timer state. Only a narrow, explicitly allowlisted subset of the
// dashboard's fields is ever forwarded; `latest.queueEvents`,
// `latest.quota`, `latest.preflights`, `latest.selections`, `latest.claims`,
// `dashboard.error`, `dashboard.diagnostics` and `dbPath` are deliberately
// never read here (see review notes) because they are not field-allowlisted
// upstream or embed local paths/raw error text.
//
// The admission circuit-breaker's persisted state is read directly with a
// bounded raw SQL query, opened `readOnly: true`, instead of going through
// AdmissionCircuitBreaker -- that class's constructor unconditionally
// creates the database file and its tables (mkdirSync + CREATE TABLE IF NOT
// EXISTS) and its check() method can DELETE a stale machine_profile row.
// Neither behavior belongs in a command whose entire contract is read-only.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { unitState } from './agent-runner-operator-doctor.mjs';
import { CANDIDATE_PAUSED_EXIT_CODE } from './agent-runner-candidate-admission.mjs';
import { defaultCircuitDbPath, effectiveConfigurationFingerprint } from './agent-runner-circuit-breaker.mjs';
import { loadAgentRunnerConfig, projectIdentity } from './agent-runner-config.mjs';
import { defaultRunnerStateDbPath } from './claude-runner-state.mjs';
import { buildRunnerDashboard } from './claude-runner-dashboard-api.mjs';

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
    db = new DatabaseSync(dbPath, { readOnly: true });
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

function boundedAttention(latestAttentionEvents = []) {
  return {
    unresolvedCount: latestAttentionEvents.filter((row) => !row.resolved_at).length,
    recent: latestAttentionEvents,
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

export function buildOperatorStatus(config, env = process.env, { now = isoNow } = {}) {
  const dbPath = env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(config.outputDir || '.var/claude-runner');
  const dashboard = buildRunnerDashboard(dbPath, { now, historyLimit: 10, strict: false, config });
  const circuit = readCircuitState(env);

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: now(),
    project: projectIdentity(config),
    ok: dashboard.ok,
    status: dashboard.status,
    schemaVersionState: dashboard.schemaVersion,
    service: unitState(config.systemd.serviceName),
    timer: unitState(config.systemd.timerName),
    circuit,
    operatorStatus: dashboard.operatorStatus,
    health: dashboard.currentHealthConditions,
    currentTask: dashboard.activity,
    queue: dashboard.metrics.queue,
    attention: boundedAttention(dashboard.latest.attentionEvents),
    notification: boundedNotification(dashboard.latest.notifications),
    issueMutation: false,
    stateMutation: false,
  };
}

export function exitCodeForStatus(report) {
  if (report.status === 'error' || report.status === 'invalid-path') return SYSTEMIC_ERROR_EXIT_CODE;
  if (report.operatorStatus?.code === 'global_systemic_pause') return SYSTEMIC_ERROR_EXIT_CODE;
  if (report.circuit?.blocked) return CANDIDATE_PAUSED_EXIT_CODE;
  return 0;
}

export function run(argv = [], env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
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
    report = buildOperatorStatus(args.config, env);
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
