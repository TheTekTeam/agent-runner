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
  return {
    issueNumber: record.issueNumber ?? plan.selectedIssue ?? null,
    statusLabel: record.statusLabel ?? plan.selectedStatusLabel ?? null,
    agentLabel: plan.agent?.agentId ? `agent:${plan.agent.agentId}` : plan.selectedAgentLabel ?? null,
    selectionMode: record.selectionMode ?? plan.selectionMode ?? null,
    commandKind: record.commandKind ?? plan.selectedCommandKind ?? null,
    commandIdentity: record.sourceCommentIdentity ?? plan.sourceCommentIdentity ?? null,
    commandRevision: record.sourceCommentId ?? plan.sourceCommentId ?? null,
    preflightIdentity: record.sourcePreflightCommentIdentity ?? plan.sourcePreflightCommentIdentity ?? null,
    preflightRevision: record.sourcePreflightCommentId ?? plan.sourcePreflightCommentId ?? null,
    preflightAuthor: plan.sourcePreflightAuthor ?? null,
  };
}

export function runAtomicCandidateRevalidation({ argv = [], env = process.env, expected, spawn = spawnSync } = {}) {
  const script = new URL('./agent-runner-candidate-admission.mjs', import.meta.url);
  const baseModule = new URL('./claude-runner-cron-base.mjs', import.meta.url).href;
  const result = spawn(process.execPath, [script.pathname], {
    encoding: 'utf8',
    env: {
      ...env,
      AGENT_RUNNER_ATOMIC_EXPECTED_JSON: JSON.stringify(expected || {}),
      AGENT_RUNNER_ATOMIC_ARGV_JSON: JSON.stringify(argv),
      AGENT_RUNNER_CANDIDATE_CRON_MODULE: baseModule,
    },
  });
  if (result.error) throw result.error;
  let parsed = null;
  try { parsed = JSON.parse(String(result.stdout || '').trim()); } catch { parsed = null; }
  if (![0, 3].includes(result.status) || !parsed?.admission) {
    throw new Error(`atomic candidate revalidation failed with exit ${result.status}: ${String(result.stderr || '').trim()}`);
  }
  return parsed;
}

export function createAtomicAdmissionStore(store, {
  argv = [],
  env = process.env,
  pauseState = { result: null },
  revalidate = runAtomicCandidateRevalidation,
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
          const result = revalidate({ argv, env, expected: selectedSnapshot });
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
          return target.recordQueueEvent(record);
        };
      }
      if (property === 'openHealthCondition') {
        return (record) => {
          if (pauseState.result && record?.conditionType === 'systemic_pause') return undefined;
          return target.openHealthCondition(record);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
