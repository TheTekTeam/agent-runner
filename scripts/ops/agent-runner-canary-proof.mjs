function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function atOrAfter(left, right) {
  const leftMs = Date.parse(left || '');
  const rightMs = Date.parse(right || '');
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs >= rightMs;
}

function draftPublication(payload = {}) {
  const publication = payload.implementationPublication || payload.publication || null;
  if (!publication || typeof publication !== 'object') return null;
  const number = Number(publication.pullRequestNumber || publication.prNumber || publication.number);
  const url = String(publication.pullRequestUrl || publication.prUrl || publication.url || '');
  const draft = publication.draft === true || String(publication.state || '').toLowerCase() === 'draft';
  return Number.isInteger(number) && number > 0 && /^https:\/\/github\.com\//.test(url) && draft
    ? { number, url, draft: true }
    : null;
}

function implementationProof(payload = {}) {
  const evidence = payload.implementationEvidence || null;
  if (!evidence || typeof evidence !== 'object') return null;
  const changedFiles = Number(evidence.changedFiles ?? evidence.changedFileCount ?? 0);
  const commit = String(evidence.commitSha || evidence.headSha || evidence.commit || '');
  return changedFiles > 0 && /^[0-9a-f]{7,40}$/i.test(commit)
    ? { changedFiles, commit }
    : null;
}

export function evaluateCanaryProof({
  issueNumber,
  claims = [],
  runResults = [],
  queueEvents = [],
  attentionEvents = [],
  dashboardSnapshot = null,
} = {}) {
  const issue = Number(issueNumber);
  const checks = {
    claimPersisted: false,
    implementationEvidence: false,
    draftPublication: false,
    terminalPersistence: false,
    notificationDelivered: false,
    dashboardRefreshed: false,
  };
  const failedChecks = [];

  const issueClaims = claims.filter((row) => Number(row.issue_number) === issue)
    .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));
  const claim = issueClaims[0] || null;
  checks.claimPersisted = Boolean(claim?.id || claim?.created_at);

  const issueRuns = runResults.filter((row) => Number(row.issue_number) === issue)
    .sort((left, right) => String(right.finished_at || right.created_at || '').localeCompare(String(left.finished_at || left.created_at || '')));
  const run = issueRuns.find((row) => row.finished_at && Number(row.exit_code) === 0) || null;
  const payload = parseObject(run?.payload_json ?? run?.payload) || {};
  const implementation = implementationProof(payload);
  const publication = draftPublication(payload);
  checks.implementationEvidence = Boolean(implementation);
  checks.draftPublication = Boolean(publication);
  checks.terminalPersistence = Boolean(run?.finished_at && Number(run.exit_code) === 0);

  const attentionDelivered = attentionEvents.some((row) => Number(row.issue_number) === issue
    && ((Number(row.notification_count) > 0) || Boolean(row.last_notification_at)));
  const queueNotification = queueEvents.some((row) => Number(row.issue_number) === issue
    && ['notification-delivered', 'attention-notified', 'runner-notification-delivered'].includes(String(row.event_type || '')));
  checks.notificationDelivered = attentionDelivered || queueNotification;

  const dashboard = parseObject(dashboardSnapshot);
  const dashboardIssue = Number(dashboard?.currentTask?.issueNumber ?? dashboard?.selectedIssue ?? dashboard?.issueNumber);
  const refreshedAt = dashboard?.refreshedAt || dashboard?.generatedAt || dashboard?.updatedAt || null;
  checks.dashboardRefreshed = Boolean(run?.finished_at && dashboardIssue === issue && atOrAfter(refreshedAt, run.finished_at));

  for (const [name, passed] of Object.entries(checks)) if (!passed) failedChecks.push(name);
  const passed = failedChecks.length === 0;
  return {
    schemaVersion: 'agent-runner-canary-proof/v1',
    issueNumber: issue,
    passed,
    failedChecks,
    checks,
    evidence: {
      claimId: claim?.id || null,
      runResultId: run?.id || null,
      finishedAt: run?.finished_at || null,
      implementation,
      publication,
      notification: checks.notificationDelivered,
      dashboardRefreshedAt: refreshedAt,
    },
    safeNextAction: passed
      ? 'Proceed to supervised reboot and recurrence proof; keep the execution timer disabled until that gate also passes.'
      : 'Do not enable the execution timer. Resolve the failed canary evidence checks and rerun the proof command.',
  };
}

export function inspectCanaryProof(store, { issueNumber, dashboardSnapshot } = {}) {
  if (!store?.db) throw new Error('runner state store with database access is required');
  const issue = Number(issueNumber);
  if (!Number.isInteger(issue) || issue < 1) throw new Error('a positive issue number is required');
  const claims = store.db.prepare('SELECT * FROM claims WHERE issue_number = ? ORDER BY created_at, id').all(issue);
  const runResults = store.db.prepare('SELECT * FROM run_results WHERE issue_number = ? ORDER BY created_at, id').all(issue);
  const queueEvents = store.db.prepare('SELECT * FROM queue_events WHERE issue_number = ? ORDER BY created_at, id').all(issue);
  const attentionEvents = store.db.prepare('SELECT * FROM attention_events WHERE issue_number = ? ORDER BY created_at, id').all(issue);
  return evaluateCanaryProof({ issueNumber: issue, claims, runResults, queueEvents, attentionEvents, dashboardSnapshot });
}
