import { MAX_EVENTS, MAX_EVENT_BYTES, HEALTH_CONDITION_CODES, boundedRepository, boundedReason, boundedToken, durationSeconds, projectName, timestampSeconds } from './agent-runner-observability-common.mjs';

function baseEvent(dashboard, row, eventType, extras = {}) {
  return {
    timestamp: row?.finished_at || row?.updated_at || row?.created_at || row?.started_at || dashboard?.generatedAt,
    event_type: eventType,
    repository: boundedRepository(row?.repo),
    project: boundedToken(row?.project, 64) || projectName(dashboard?.project),
    issue_number: Number.isInteger(row?.issue_number) ? row.issue_number : null,
    phase: boundedToken(row?.phase, 64),
    outcome: boundedReason(extras.outcome),
    reason_code: boundedReason(extras.reasonCode),
    duration_seconds: Number.isFinite(extras.durationSeconds) ? Math.max(0, Math.round(extras.durationSeconds)) : null,
    node: boundedToken(extras.node, 64),
    correlation_id: null,
  };
}

export function buildTypedEvents(dashboard, { node, limit = MAX_EVENTS } = {}) {
  const latest = dashboard?.latest || {};
  const events = [];
  for (const row of latest.selections || []) events.push(baseEvent(dashboard, row, 'issue_selected', { node, outcome: row?.selection_mode, reasonCode: row?.status_label }));
  for (const row of latest.claims || []) events.push(baseEvent(dashboard, row, 'issue_claimed', { node, outcome: 'claimed' }));
  for (const row of latest.runResults || []) {
    if (row?.mode === 'issue-run') events.push(baseEvent(dashboard, row, row?.exit_code === 0 ? 'run_completed' : 'run_failed', { node, outcome: row?.exit_code === 0 ? 'success' : 'failure', durationSeconds: durationSeconds(row) }));
    else events.push(baseEvent(dashboard, row, 'scheduler_outcome', { node, outcome: row?.mode }));
  }
  for (const row of latest.quota || []) if (row?.blocked === 1 || row?.blocked === true) events.push(baseEvent(dashboard, row, 'quota_blocked', { node, outcome: 'blocked', reasonCode: row?.reason }));
  for (const row of latest.recoveryAttempts || []) {
    const type = !row?.finished_at ? 'recovery_started' : row?.outcome === 'recovered' || row?.exit_code === 0 ? 'recovery_completed' : 'recovery_failed';
    events.push(baseEvent(dashboard, row, type, { node, outcome: row?.outcome, durationSeconds: durationSeconds(row) }));
  }
  for (const row of latest.attentionEvents || []) events.push(baseEvent(dashboard, row, row?.resolved_at ? 'attention_resolved' : 'attention_opened', { node, outcome: row?.resolved_at ? 'resolved' : 'open', reasonCode: row?.reason, durationSeconds: durationSeconds(row) }));
  for (const row of latest.healthConditions || []) if (HEALTH_CONDITION_CODES.has(row?.condition_type)) events.push(baseEvent(dashboard, row, row?.resolved_at ? 'health_condition_resolved' : 'health_condition_opened', { node, outcome: row?.condition_type, reasonCode: row?.reason }));

  const seen = new Set();
  return events.filter((event) => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => timestampSeconds(right.timestamp) - timestampSeconds(left.timestamp)).slice(0, Math.min(limit, MAX_EVENTS));
}

export function renderTypedEvents(dashboard, options = {}) {
  const lines = [];
  let bytes = 0;
  for (const event of buildTypedEvents(dashboard, options)) {
    const line = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(line);
    if (bytes + size > MAX_EVENT_BYTES) break;
    lines.push(line);
    bytes += size;
  }
  return lines.join('');
}
