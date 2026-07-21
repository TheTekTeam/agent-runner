import { execFileSync } from 'node:child_process';

import {
  classifyAttemptLivenessState,
  computeAttemptLivenessEvidence,
} from './claude-runner-cron.mjs';

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function issueComments(repo, issueNumber, ghRunner = defaultGh) {
  const raw = ghRunner(['issue', 'view', String(issueNumber), '--repo', repo, '--comments', '--json', 'comments']);
  return JSON.parse(raw || '{}').comments || [];
}

export function liveSchedulingDecision(row, evidence = {}, at = new Date().toISOString()) {
  const classifierState = classifyAttemptLivenessState(row, evidence);
  if (classifierState === 'actively_owned') return { allowed: false, action: 'preserve', classifierState, reason: 'attempt-actively-owned' };
  if (classifierState === 'resolved') return { allowed: false, action: 'reconcile-finished', classifierState, reason: 'attempt-finished' };
  if (classifierState === 'operator_held') return { allowed: false, action: 'operator-hold', classifierState, reason: 'attempt-operator-held' };
  if (classifierState === 'delayed_bounded_retry') return { allowed: false, action: 'wait', classifierState, reason: 'retry-deadline-not-reached' };

  const deadline = Date.parse(row?.next_retry_at || '');
  const now = Date.parse(at);
  const due = Number.isFinite(deadline) && Number.isFinite(now) && deadline <= now;
  const recoverable = row?.resolution_state === 'unresolved'
    && Boolean(row?.recovery_eligible)
    && evidence.liveProcessRaw === false
    && evidence.leaseCurrent === true
    && evidence.authorityCurrent === true
    && evidence.boundedRetryPolicyProven === true
    && due;
  if (recoverable) return { allowed: true, action: 'recover', classifierState: 'stale_recoverable', reason: 'bounded-retry-due' };

  const uncertain = evidence.liveProcessRaw == null || evidence.authorityCurrent !== true || evidence.leaseCurrent !== true;
  return {
    allowed: false,
    action: uncertain ? 'preserve-for-inspection' : 'quarantine',
    classifierState: uncertain ? 'uncertain' : classifierState,
    reason: uncertain ? 'attempt-liveness-uncertain' : 'attempt-liveness-conflicting',
  };
}

export async function inspectDueRecoveryLiveness({
  store,
  repo,
  at = new Date().toISOString(),
  ghRunner = defaultGh,
  processProbe,
  stallPassLimit,
  now = () => at,
} = {}) {
  const due = store.dueRecoveryAttempts(repo, at) || [];
  const active = store.activeRecoveryAttempts(repo) || [];
  const decisions = [];
  for (const row of due) {
    const comments = issueComments(repo, row.issue_number, ghRunner);
    const otherLease = active.some((candidate) => candidate.attempt_id !== row.attempt_id && candidate.issue_number === row.issue_number);
    const evidence = await computeAttemptLivenessEvidence(row, {
      processProbe,
      comments,
      otherLease,
      now,
      stallPassLimit,
    });
    const decision = liveSchedulingDecision(row, evidence, at);
    const record = { attemptId: row.attempt_id, issueNumber: row.issue_number, ...decision, evidence };
    decisions.push(record);
    store.recordQueueEvent({
      repo,
      eventType: decision.allowed ? 'liveness-recovery-admitted' : 'liveness-recovery-withheld',
      issueNumber: row.issue_number,
      reason: decision.reason,
      payload: {
        attemptId: row.attempt_id,
        action: decision.action,
        classifierState: decision.classifierState,
        childLaunched: false,
        issueMutation: false,
      },
    });
  }
  return decisions;
}

export function createLivenessFilteredStore(store, decisions = []) {
  const allowed = new Set(decisions.filter((decision) => decision.allowed).map((decision) => decision.attemptId));
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'dueRecoveryAttempts') {
        return (...args) => target.dueRecoveryAttempts(...args).filter((row) => allowed.has(row.attempt_id));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
