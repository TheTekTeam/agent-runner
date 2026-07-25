import { spawnSync } from 'node:child_process';

import { candidatePausePayload } from './agent-runner-candidate-admission.mjs';

export class CandidateAdmissionPausedError extends Error {
  constructor(result) {
    super(`candidate admission paused: ${result?.admission?.reason || 'unknown'}`);
    this.name = 'CandidateAdmissionPausedError';
    this.code = 'CANDIDATE_ADMISSION_PAUSED';
    this.result = result;
  }
}

export function snapshotFromSelectionRecord(record = {}) {
  const plan = record.payload || record;
  const preflightIdentity = record.sourcePreflightCommentIdentity
    ?? plan.sourcePreflightCommentIdentity
    ?? null;
  const preflightRevision = record.sourcePreflightRevision
    ?? plan.sourcePreflightRevision
    ?? null;
  const preflightFingerprint = record.sourcePreflightFingerprint
    ?? plan.sourcePreflightFingerprint
    ?? null;
  const preflightAuthorityKey = record.sourcePreflightAuthorityKey
    ?? plan.sourcePreflightAuthorityKey
    ?? null;
  const preflightBodyDigest = record.sourcePreflightBodyDigest
    ?? plan.sourcePreflightBodyDigest
    ?? null;
  const preflightApprovedAgent = record.sourcePreflightApprovedAgent
    ?? plan.sourcePreflightApprovedAgent
    ?? plan.agent?.agentId
    ?? null;
  const explicitPacketValid = record.sourcePreflightPacketValid
    ?? plan.sourcePreflightPacketValid;
  return {
    issueNumber: record.issueNumber ?? plan.selectedIssue ?? null,
    statusLabel: record.statusLabel ?? plan.selectedStatusLabel ?? null,
    agentLabel: plan.agent?.agentId ? `agent:${plan.agent.agentId}` : plan.selectedAgentLabel ?? null,
    selectionMode: record.selectionMode ?? plan.selectionMode ?? null,
    commandKind: record.commandKind ?? plan.selectedCommandKind ?? null,
    commandIdentity: record.sourceCommentIdentity ?? plan.sourceCommentIdentity ?? null,
    commandRevision: record.sourceCommentId ?? plan.sourceCommentId ?? null,
    preflightIdentity,
    preflightRevision,
    preflightFingerprint,
    preflightAuthorityKey,
    preflightBodyDigest,
    preflightPacketValid: explicitPacketValid === undefined
      ? Boolean(
        preflightRevision
        && preflightFingerprint
        && preflightAuthorityKey
        && preflightBodyDigest
        && preflightApprovedAgent
      )
      : explicitPacketValid === true,
    preflightPacketReason: record.sourcePreflightPacketReason
      ?? plan.sourcePreflightPacketReason
      ?? null,
    preflightApprovedAgent,
    preflightCommentRevision: record.sourcePreflightCommentId
      ?? plan.sourcePreflightCommentId
      ?? null,
    preflightAuthor: record.sourcePreflightAuthor ?? plan.sourcePreflightAuthor ?? null,
  };
}

const MISSING_MODULE_PATTERN = /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_A_DIRECTORY/;

// The atomic revalidation subprocess must run against the plain scheduler
// module, never the atomic wrapper (`agent-runner-atomic-cron.mjs`) — that
// wrapper itself spawns this revalidation, so pointing at it would recurse.
// This mirrors the fallback already used by `selectorFor()` in
// `agent-runner-candidate-admission.mjs`.
export class CandidateRevalidationUnavailableError extends Error {
  constructor(message, { cause = null, missingModule = false } = {}) {
    super(message);
    this.name = 'CandidateRevalidationUnavailableError';
    this.code = missingModule ? 'CANDIDATE_REVALIDATION_MODULE_NOT_FOUND' : 'CANDIDATE_REVALIDATION_UNAVAILABLE';
    this.missingModule = missingModule;
    if (cause) this.cause = cause;
  }
}

export function runAtomicCandidateRevalidation({ argv = [], env = process.env, expected, spawn = spawnSync } = {}) {
  const script = new URL('./agent-runner-candidate-admission.mjs', import.meta.url);
  const baseModule = new URL('./claude-runner-cron.mjs', import.meta.url).href;
  const result = spawn(process.execPath, [script.pathname], {
    encoding: 'utf8',
    env: {
      ...env,
      AGENT_RUNNER_ATOMIC_EXPECTED_JSON: JSON.stringify(expected || {}),
      AGENT_RUNNER_ATOMIC_ARGV_JSON: JSON.stringify(argv),
      AGENT_RUNNER_CANDIDATE_CRON_MODULE: baseModule,
    },
  });
  if (result.error) {
    throw new CandidateRevalidationUnavailableError(
      `atomic candidate revalidation process failed to start: ${result.error.message}`,
      { cause: result.error, missingModule: result.error.code === 'ERR_MODULE_NOT_FOUND' },
    );
  }
  let parsed = null;
  try { parsed = JSON.parse(String(result.stdout || '').trim()); } catch { parsed = null; }
  if (![0, 3].includes(result.status) || !parsed?.admission) {
    const stderr = String(result.stderr || '').trim();
    throw new CandidateRevalidationUnavailableError(
      `atomic candidate revalidation failed with exit ${result.status}: ${stderr}`,
      { missingModule: MISSING_MODULE_PATTERN.test(stderr) },
    );
  }
  return parsed;
}

// Single source of truth for how a broken atomic revalidation subprocess is
// reported, so the durable `queue_events`/`runner_health_conditions` rows
// written during the imported scheduler's own (mislabelled)
// `emitSystemicStatePause` and the corrected stdout evidence in
// `agent-runner-atomic-cron.mjs` always agree.
export function revalidationFailureEvidence(failure) {
  const missingModule = failure instanceof CandidateRevalidationUnavailableError && failure.missingModule === true;
  return {
    missingModule,
    reason: missingModule ? 'runner_code_unavailable' : 'candidate_revalidation_unavailable',
    safeNextAction: missingModule
      ? 'Restore the missing standalone runner module before dispatching or mutating any issue. This is a missing-code failure, not a state-store failure.'
      : 'Repair the atomic candidate-revalidation subprocess before dispatching or mutating any issue. This is not a state-store failure.',
  };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function canaryIssueMismatchResult(expectedIssueNumber, selectedSnapshot, record = {}) {
  const selectedIssueNumber = positiveInteger(selectedSnapshot?.issueNumber ?? record?.issueNumber);
  if (!expectedIssueNumber || selectedIssueNumber === expectedIssueNumber) return null;
  return {
    admission: {
      allowed: false,
      scope: 'issue_not_runnable',
      reason: 'canary-issue-mismatch',
      safeNextAction: `Keep the timer disabled and rerun the supervised canary only when issue #${expectedIssueNumber} is the exact selected candidate.`,
      expectedIssueNumber,
      selectedIssueNumber,
    },
    current: selectedSnapshot || { issueNumber: selectedIssueNumber },
  };
}

export function createAtomicAdmissionStore(store, {
  argv = [],
  env = process.env,
  pauseState = { result: null },
  revalidate = runAtomicCandidateRevalidation,
  expectedIssueNumber = positiveInteger(env.AGENT_RUNNER_CANARY_ISSUE),
} = {}) {
  let selectedSnapshot = null;
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'recordIssueSelection') {
        return (record) => {
          selectedSnapshot = snapshotFromSelectionRecord(record);
          return target.recordIssueSelection(record);
        };
      }
      if (property === 'recordRecoveryAttempt') {
        return (record) => {
          const initialAttempt = record?.phase === 'starting'
            && record?.resolutionState === 'active'
            && record?.finishedAt == null;
          if (!initialAttempt) return target.recordRecoveryAttempt(record);
          const mismatch = canaryIssueMismatchResult(expectedIssueNumber, selectedSnapshot, record);
          if (mismatch) {
            pauseState.result = mismatch;
            throw new CandidateAdmissionPausedError(mismatch);
          }
          let result;
          try {
            result = revalidate({ argv, env, expected: selectedSnapshot });
          } catch (error) {
            // The imported scheduler's own state recorder cannot distinguish
            // this from a genuine store failure (it catches every
            // `store[method]()` throw uniformly) and will report
            // `runner_state_unavailable` regardless of cause. Stash the real
            // failure here — the one boundary that knows it's actually the
            // atomic revalidation subprocess, not the state store — so the
            // outer `agent-runner-atomic-cron.mjs` wrapper can correct the
            // evidence after the (still fail-closed) throw propagates.
            pauseState.revalidationFailure = error;
            throw error;
          }
          if (result.admission.allowed !== true) {
            pauseState.result = result;
            throw new CandidateAdmissionPausedError(result);
          }
          return target.recordRecoveryAttempt(record);
        };
      }
      if (property === 'recordQueueEvent') {
        return (record) => {
          if (pauseState.result && record?.eventType === 'systemic-pause') {
            const payload = candidatePausePayload(pauseState.result.admission, pauseState.result.current);
            return target.recordQueueEvent({
              ...record,
              eventType: 'candidate-admission-paused',
              issueNumber: payload.selectedIssue,
              reason: payload.reason,
              payload,
            });
          }
          // The imported scheduler's `emitSystemicStatePause` already wrote
          // `reason: 'runner_state_unavailable'` into this record before
          // control returns to this trap — correct it here so the durable
          // audit trail (not just stdout) never misreports a broken
          // revalidation subprocess as a state-store failure. This stays a
          // systemic-pause event (not `candidate-admission-paused`): a
          // missing module is not a candidate denial.
          if (pauseState.revalidationFailure && record?.eventType === 'systemic-pause') {
            const evidence = revalidationFailureEvidence(pauseState.revalidationFailure);
            return target.recordQueueEvent({
              ...record,
              reason: evidence.reason,
              payload: { ...(record.payload || {}), reason: evidence.reason, safeNextAction: evidence.safeNextAction },
            });
          }
          return target.recordQueueEvent(record);
        };
      }
      if (property === 'openHealthCondition') {
        return (record) => {
          if (pauseState.result && record?.conditionType === 'systemic_pause') return undefined;
          if (pauseState.revalidationFailure && record?.conditionType === 'systemic_pause') {
            const evidence = revalidationFailureEvidence(pauseState.revalidationFailure);
            return target.openHealthCondition({ ...record, reason: evidence.reason, safeNextAction: evidence.safeNextAction });
          }
          return target.openHealthCondition(record);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
