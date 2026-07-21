export const HANDLED_FAILURE_SCOPES = new Set([
  'machine_profile',
  'issue_not_runnable',
  'task_attempt',
  'completed',
]);

export function parseStructuredOutput(values = []) {
  if (values.length !== 1 || typeof values[0] !== 'string') return null;
  try {
    const value = JSON.parse(values[0]);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function isSystemicOutcome(payload) {
  return Boolean(
    payload?.systemicPause
    || payload?.failureScope === 'systemic'
    || payload?.reason === 'runner_state_unavailable'
    || (Array.isArray(payload?.statePersistenceErrors) && payload.statePersistenceErrors.length > 0),
  );
}

export function isHandledOutcome(payload) {
  if (!payload || isSystemicOutcome(payload)) return false;
  if (HANDLED_FAILURE_SCOPES.has(payload.failureScope)) return true;
  return Boolean(
    payload.profilePaused
    || payload.circuitOpen
    || payload.candidatePaused
    || payload.quotaBlocked
    || payload.recoveryBlocked
    || payload.attentionDedupeKey
    || payload.terminalOutcome
    || payload.executionStatus === 'not_executed'
    || payload.mode === 'no-selection',
  );
}

export function serviceExitCode(exitCode, payload) {
  if (!Number.isInteger(exitCode) || exitCode === 0) return exitCode || 0;
  return isHandledOutcome(payload) ? 0 : exitCode;
}
