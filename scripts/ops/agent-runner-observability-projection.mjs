import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';
import {
  DEFAULT_HISTORY_LIMIT, HEALTH_CONDITION_CODES, TABLES, boundedRepository,
  boundedToken, durationSeconds, finiteNumber, isoNow, timestampSeconds,
} from './agent-runner-observability-common.mjs';

const QUERIES = Object.freeze({
  queueEvents: ['queue_events', 'id', ['id','created_at','repo','event_type','issue_number','status_label','reason']],
  quota: ['quota_history', 'id', ['id','created_at','repo','status','blocked','skipped','reason','session_usage_percent','weekly_usage_percent','reset_at']],
  preflights: ['preflight_packets', 'id', ['id','created_at','repo','issue_number','stale','action']],
  selections: ['issue_selections', 'id', ['id','created_at','repo','issue_number','status_label','selection_mode','command_kind','dry_run']],
  claims: ['claims', 'id', ['id','created_at','repo','issue_number','action','status_label','selection_mode']],
  runResults: ['run_results', 'id', ['id','created_at','started_at','finished_at','repo','issue_number','mode','exit_code','signal']],
  recoveryAttempts: ['recovery_attempts', 'started_at', [
    'attempt_id','repo','project','issue_number','phase','agent','started_at','finished_at',
    'outcome','exit_code','signal','recovery_eligible','recovery_action','recovery_attempt_count',
    'retry_at','attention_status','resolution_state',
  ]],
  recoveryRevalidations: ['recovery_revalidations', 'id', ['id','attempt_id','stage','checked_at','action','allowed']],
  attentionEvents: ['attention_events', 'id', [
    'id','created_at','updated_at','repo','project','issue_number','reason','agent',
    'started_at','finished_at','recovery_status','next_action','notification_count',
    'last_notification_at','resolved_at',
  ]],
  healthConditions: ['runner_health_conditions', 'id', ['id','repo','condition_type','reason','opened_at','updated_at','resolved_at','safe_next_action']],
  routingEvents: ['routing_events', 'id', ['id','created_at','repo','issue_number','event_type','from_agent_id','to_agent_id','reason','delivery_status']],
  notifications: ['notification_events', 'id', [
    'id','created_at','updated_at','repo','project','issue_number','event_type','reason_code',
    'agent','source_table','occurred_at','delivery_status','attempt_count','max_attempts',
    'next_attempt_at','last_attempt_at','delivered_at','resolved_at','last_error',
  ]],
});

function emptyCounts() { return Object.fromEntries(TABLES.map((table) => [table, 0])); }
function emptyLatest() { return Object.fromEntries(Object.keys(QUERIES).map((key) => [key, []])); }

function projectionError(dbPath, status, generatedAt, schemaVersion = null) {
  return {
    ok: status === 'missing', status, dbPath, schemaVersion, generatedAt, project: null,
    counts: emptyCounts(), latest: emptyLatest(), currentHealthConditions: [],
    metrics: {
      runs: { averageDurationSeconds: 0 }, queue: { skipEventCount: 0 },
      quota: { latestSessionUsagePercent: 0, latestWeeklyUsagePercent: 0 },
    },
    activity: { activeIssue: null }, operatorStatus: { code: 'idle' },
  };
}

function configuredProject(config = {}) {
  return {
    project: boundedToken(config.projectId, 64),
    displayName: boundedToken(config.displayName, 64),
    repository: boundedRepository(config.githubRepo),
  };
}

function activeIssue(latest) {
  const activeAttempt = (latest.recoveryAttempts || []).find((row) => !row?.finished_at);
  if (activeAttempt && Number.isInteger(activeAttempt.issue_number)) {
    return {
      repo: activeAttempt.repo, project: activeAttempt.project, issue_number: activeAttempt.issue_number,
      agent: activeAttempt.agent, assignment_label: null, mode: 'issue-run', status: 'active',
    };
  }
  const claim = latest.claims?.[0];
  if (!claim || !Number.isInteger(claim.issue_number)) return null;
  const terminal = latest.runResults?.[0];
  if (timestampSeconds(claim.created_at) <= timestampSeconds(terminal?.finished_at || terminal?.created_at)) return null;
  return { repo: claim.repo, project: null, issue_number: claim.issue_number, agent: null, assignment_label: null, mode: 'claim', status: 'active' };
}

function metrics(latest) {
  const issueRuns = (latest.runResults || []).filter((row) => row?.mode === 'issue-run');
  const durations = issueRuns.map(durationSeconds).filter(Number.isFinite);
  const quota = latest.quota?.[0] || {};
  return {
    runs: { averageDurationSeconds: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0 },
    queue: { skipEventCount: (latest.queueEvents || []).filter((row) => row?.event_type === 'skip').length },
    quota: {
      latestSessionUsagePercent: finiteNumber(quota.session_usage_percent),
      latestWeeklyUsagePercent: finiteNumber(quota.weekly_usage_percent),
    },
  };
}

function operatorStatus(latest, conditions, issue) {
  if (conditions.some((row) => row?.condition_type === 'systemic_pause')) return { code: 'global_systemic_pause' };
  if ((latest.attentionEvents || []).some((row) => !row?.resolved_at)) return { code: 'attention_required' };
  if ((latest.queueEvents || []).some((row) => ['quarantine','approval-wait'].includes(row?.event_type))) return { code: 'task_local_quarantines' };
  if (issue) return { code: 'queue_moving' };
  if (conditions.some((row) => row?.condition_type === 'queue_inspection_degraded')) return { code: 'queue_inspection_degraded' };
  return { code: 'idle' };
}

export function readRunnerProjection(dbPath, { config = {}, historyLimit = DEFAULT_HISTORY_LIMIT, now = isoNow } = {}) {
  const generatedAt = now();
  if (!dbPath || typeof dbPath !== 'string' || !dbPath.startsWith('/')) return projectionError(dbPath, 'invalid-path', generatedAt);
  if (!existsSync(dbPath)) return projectionError(dbPath, 'missing', generatedAt);

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    const schemaVersion = Number.parseInt(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? '', 10);
    if (schemaVersion !== RUNNER_STATE_SCHEMA_VERSION) return projectionError(dbPath, 'error', generatedAt, schemaVersion);

    const counts = {};
    for (const table of TABLES) counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
    const latest = {};
    for (const [key, [table, order, columns]] of Object.entries(QUERIES)) {
      latest[key] = db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order} DESC LIMIT ?`).all(historyLimit);
    }
    const conditions = (latest.healthConditions || []).filter((row) => !row?.resolved_at && HEALTH_CONDITION_CODES.has(row?.condition_type));
    const issue = activeIssue(latest);
    return {
      ok: true, status: 'ok', dbPath, schemaVersion, generatedAt,
      project: configuredProject(config), counts, latest, currentHealthConditions: conditions,
      metrics: metrics(latest), activity: { activeIssue: issue }, operatorStatus: operatorStatus(latest, conditions, issue),
    };
  } catch {
    return projectionError(dbPath, 'error', generatedAt);
  } finally {
    db?.close();
  }
}
