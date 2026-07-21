const MACHINE_PROFILE_REASONS = new Set([
  'execution-authorization-blocked',
  'implementation-authorization-blocked',
  'implementation-not-authorized',
  'implementation-approver-not-allowed',
  'adapter-not-enabled',
  'adapter-unsupported',
]);

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedReason(payload = {}, attempt = {}) {
  return String(
    payload.failureReason
      || payload.outcomeReason
      || payload.reason
      || payload.childRunFailure?.reason
      || attempt.outcome
      || '',
  ).trim().toLowerCase().replaceAll('_', '-');
}

export function classifyQueueDrainAttempt({ run, attempt, queueEvents = [] } = {}) {
  if (!run || !attempt) {
    return { classification: 'ambiguous', restorableCandidate: false, reason: 'missing-durable-row' };
  }
  const payload = parseObject(run.payload_json ?? run.payload);
  if (!payload) {
    return { classification: 'ambiguous', restorableCandidate: false, reason: 'malformed-run-payload' };
  }
  if (run.repo !== attempt.repo || run.issue_number !== attempt.issue_number || run.started_at !== attempt.started_at) {
    return { classification: 'ambiguous', restorableCandidate: false, reason: 'run-attempt-identity-mismatch' };
  }

  const reason = normalizedReason(payload, attempt);
  const machineProfileReason = MACHINE_PROFILE_REASONS.has(reason);
  const childLaunched = payload.childLaunched === true
    || payload.executionStatus === 'executed'
    || payload.claim != null
    || payload.implementationEvidence != null
    || payload.implementationPublication != null
    || payload.worktreeIdentity != null;
  const blockedMutation = queueEvents.some((event) => ['quarantine', 'approval-wait'].includes(event.event_type))
    || payload.quarantine?.statusUpdated === true
    || payload.failureRecovery?.statusUpdated === true;
  const preLaunch = payload.executionStatus === 'not_executed'
    || payload.childLaunched === false
    || (!childLaunched && payload.exitCode != null);

  if (machineProfileReason && preLaunch && !childLaunched && blockedMutation) {
    return {
      classification: 'machine_profile_false_block',
      restorableCandidate: true,
      reason,
      evidence: {
        preLaunch: true,
        childLaunched: false,
        blockedMutation: true,
        implementationEvidencePresent: false,
      },
    };
  }
  if (machineProfileReason && (childLaunched || !preLaunch)) {
    return { classification: 'ambiguous', restorableCandidate: false, reason: 'machine-profile-reason-with-execution-evidence' };
  }
  if (childLaunched) {
    return { classification: 'task_attempt', restorableCandidate: false, reason: reason || 'task-executed' };
  }
  return { classification: 'not_incident', restorableCandidate: false, reason: reason || 'unrelated-outcome' };
}

export function classifyQueueDrainRows({ runs = [], attempts = [], queueEvents = [] } = {}) {
  const attemptsByIdentity = new Map(attempts.map((attempt) => [
    `${attempt.repo}#${attempt.issue_number}:${attempt.started_at}`,
    attempt,
  ]));
  const classifications = runs.map((run) => {
    const identity = `${run.repo}#${run.issue_number}:${run.started_at}`;
    const attempt = attemptsByIdentity.get(identity) || null;
    const events = queueEvents.filter((event) => event.repo === run.repo
      && event.issue_number === run.issue_number
      && event.created_at >= run.started_at
      && event.created_at <= run.created_at);
    return {
      incidentRecordId: identity,
      runResultId: run.id,
      attemptId: attempt?.attempt_id || null,
      issueNumber: run.issue_number,
      ...classifyQueueDrainAttempt({ run, attempt, queueEvents: events }),
    };
  });
  return {
    total: classifications.length,
    machineProfileFalseBlocks: classifications.filter((entry) => entry.classification === 'machine_profile_false_block').length,
    ambiguous: classifications.filter((entry) => entry.classification === 'ambiguous').length,
    taskAttempts: classifications.filter((entry) => entry.classification === 'task_attempt').length,
    notIncident: classifications.filter((entry) => entry.classification === 'not_incident').length,
    classifications,
  };
}

export function inspectQueueDrainIncident(store, {
  repo,
  startAt = '2026-07-20T00:00:00.000Z',
  endAt = '2026-07-21T00:00:00.000Z',
} = {}) {
  if (!store?.db) throw new Error('runner state store with database access is required');
  if (!repo) throw new Error('repository is required');
  const runs = store.db.prepare(`SELECT * FROM run_results
    WHERE repo = ? AND started_at >= ? AND started_at < ? ORDER BY started_at, id`).all(repo, startAt, endAt);
  const attempts = store.db.prepare(`SELECT * FROM recovery_attempts
    WHERE repo = ? AND started_at >= ? AND started_at < ? ORDER BY started_at`).all(repo, startAt, endAt);
  const queueEvents = store.db.prepare(`SELECT * FROM queue_events
    WHERE repo = ? AND created_at >= ? AND created_at < ? ORDER BY created_at, id`).all(repo, startAt, endAt);
  return classifyQueueDrainRows({ runs, attempts, queueEvents });
}
