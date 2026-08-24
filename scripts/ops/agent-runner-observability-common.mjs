export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_PORT = 9914;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;
export const MAX_EVENTS = 100;
export const MAX_EVENT_BYTES = 256 * 1024;

export const STATE_STATUSES = new Set(['ok', 'missing', 'invalid-path', 'error']);
export const OPERATOR_CODES = new Set([
  'global_systemic_pause',
  'attention_required',
  'task_local_quarantines',
  'queue_moving',
  'queue_inspection_degraded',
  'idle',
]);
export const HEALTH_CONDITION_CODES = new Set(['systemic_pause', 'queue_inspection_degraded']);
export const TABLES = Object.freeze([
  'queue_events', 'quota_history', 'preflight_packets', 'issue_selections', 'claims',
  'run_results', 'recovery_attempts', 'recovery_revalidations', 'attention_events',
  'runner_health_conditions', 'routing_events', 'notification_events',
]);

export function isoNow() { return new Date().toISOString(); }

export function parseInteger(value, { fallback, min, max }) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function boundedToken(value, max = 64) {
  const token = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(token) && token.length <= max ? token : null;
}

export function boundedRepository(value) {
  const repository = boundedToken(value, 128);
  return repository && repository.includes('/') ? repository : null;
}

export function boundedReason(value) {
  const reason = String(value ?? '').trim();
  return /^[a-z0-9][a-z0-9._:-]*$/.test(reason) && reason.length <= 64 ? reason : null;
}

export function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function timestampSeconds(value) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

export function durationSeconds(row) {
  const started = Date.parse(String(row?.started_at ?? ''));
  const finished = Date.parse(String(row?.finished_at ?? ''));
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? (finished - started) / 1000
    : null;
}

export function projectName(project) {
  if (typeof project === 'string') return boundedToken(project, 64);
  for (const candidate of [project?.project, project?.name, project?.id, project?.slug]) {
    const bounded = boundedToken(candidate, 64);
    if (bounded) return bounded;
  }
  return null;
}
