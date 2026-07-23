#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig, stripConfigArgs } from './agent-runner-config.mjs';
import {
  deserializeCommentIdentity,
  normalizeCommentIdentity,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function atOrAfter(left, right) {
  const leftMs = timestamp(left);
  const rightMs = timestamp(right);
  return leftMs !== null && rightMs !== null && leftMs >= rightMs;
}

function rowAtOrAfter(row, since) {
  return atOrAfter(row?.created_at || row?.started_at || row?.finished_at, since);
}

function identityFromRow(row, jsonField, fallbackField, context) {
  return deserializeCommentIdentity(row?.[jsonField] || row?.[fallbackField], context);
}

function payloadIdentity(payload = {}) {
  return normalizeCommentIdentity(
    payload.sourcePreflightCommentIdentity
      || payload.sourcePreflightCommentId
      || payload.sourcePreflightRevision
      || null,
    { context: 'canary-proof-run-preflight' },
  );
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

function implementationCompletion(payload = {}) {
  const evidence = payload.implementationEvidence || null;
  if (!evidence || typeof evidence !== 'object') return null;
  const changedFiles = Number(evidence.changedFiles ?? evidence.changedFileCount ?? 0);
  const commit = String(evidence.commitSha || evidence.headSha || evidence.commit || '');
  if (changedFiles > 0 && /^[0-9a-f]{7,40}$/i.test(commit)) {
    return { kind: 'changed', changedFiles, commit };
  }
  const explicitNoChange = payload.terminalOutcome === 'completed'
    && evidence.repositoryMutated === false
    && changedFiles === 0;
  return explicitNoChange ? { kind: 'no-change', changedFiles: 0, commit: null } : null;
}

function dashboardContainsEvidence(dashboard, { issueNumber, attemptId, runResultId, finishedAt }) {
  if (!dashboard || typeof dashboard !== 'object') return false;
  const generatedAt = dashboard.generatedAt || dashboard.refreshedAt || dashboard.updatedAt || null;
  if (!atOrAfter(generatedAt, finishedAt)) return false;
  const runRows = dashboard.latest?.runResults || dashboard.runResults || [];
  const attemptRows = dashboard.latest?.recoveryAttempts || dashboard.recoveryAttempts || [];
  const exactRun = runRows.some((row) => Number(row?.id) === Number(runResultId)
    && Number(row?.issue_number ?? row?.issueNumber) === Number(issueNumber));
  const exactAttempt = attemptRows.some((row) => String(row?.attempt_id ?? row?.attemptId) === String(attemptId));
  return exactRun && exactAttempt;
}

function notificationStatus({ attentionEvents = [], queueEvents = [], issueNumber, attemptId, terminalSucceeded, runPayload }) {
  const deliveredAttention = attentionEvents.some((row) => Number(row.issue_number) === Number(issueNumber)
    && String(row.attempt_id) === String(attemptId)
    && ((Number(row.notification_count) > 0) || Boolean(row.last_notification_at)));
  const deliveredQueue = queueEvents.some((row) => {
    if (Number(row.issue_number) !== Number(issueNumber)) return false;
    if (!['notification-delivered', 'attention-notified', 'runner-notification-delivered'].includes(String(row.event_type || ''))) return false;
    const payload = parseObject(row.payload_json) || {};
    return !payload.attemptId || String(payload.attemptId) === String(attemptId);
  });
  if (deliveredAttention || deliveredQueue) return 'delivered';
  if (terminalSucceeded && runPayload.attentionDedupeKey == null && runPayload.failureRecovery == null) return 'not-required';
  return 'missing';
}

export function evaluateCanaryProof({
  issueNumber,
  sourcePreflightComment,
  since,
  claims = [],
  recoveryAttempts = [],
  runResults = [],
  queueEvents = [],
  attentionEvents = [],
  dashboardSnapshot = null,
} = {}) {
  const issue = Number(issueNumber);
  const sourceIdentity = normalizeCommentIdentity(sourcePreflightComment, { context: 'canary-proof-source', required: true });
  if (!Number.isInteger(issue) || issue < 1) throw new Error('a positive issue number is required');
  if (!sourceIdentity) throw new Error('a source preflight comment identity is required');
  if (timestamp(since) === null) throw new Error('a valid --since timestamp is required');

  const correlatedClaims = claims
    .filter((row) => Number(row.issue_number) === issue && rowAtOrAfter(row, since))
    .filter((row) => sameCommentIdentity(
      identityFromRow(row, 'source_preflight_comment_identity_json', 'source_preflight_comment_id', 'canary-proof-claim'),
      sourceIdentity,
    ))
    .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')));
  const claim = correlatedClaims[0] || null;

  const correlatedAttempts = recoveryAttempts
    .filter((row) => Number(row.issue_number) === issue && rowAtOrAfter(row, since))
    .filter((row) => sameCommentIdentity(
      identityFromRow(row, 'preflight_identity_json', 'preflight_revision', 'canary-proof-attempt'),
      sourceIdentity,
    ))
    .sort((left, right) => String(left.started_at || '').localeCompare(String(right.started_at || '')));
  const attempt = correlatedAttempts[0] || null;

  const correlatedRuns = runResults
    .filter((row) => Number(row.issue_number) === issue && rowAtOrAfter(row, since))
    .map((row) => ({ row, payload: parseObject(row.payload_json ?? row.payload) || {} }))
    .filter(({ row, payload }) => {
      if (!attempt) return false;
      const exactStart = String(payload.startedAt || row.started_at || '') === String(attempt.started_at || '');
      const exactPreflight = sameCommentIdentity(payloadIdentity(payload), sourceIdentity);
      return exactStart && exactPreflight;
    })
    .sort((left, right) => String(left.row.finished_at || left.row.created_at || '').localeCompare(String(right.row.finished_at || right.row.created_at || '')));
  const terminal = correlatedRuns.find(({ row }) => Boolean(row.finished_at)) || null;
  const run = terminal?.row || null;
  const runPayload = terminal?.payload || {};

  const workerStarted = Boolean(run || (attempt?.phase && attempt.phase !== 'starting') || attempt?.finished_at);
  const terminalSucceeded = Boolean(run?.finished_at && Number(run.exit_code) === 0 && runPayload.terminalOutcome === 'completed');
  const terminalFailed = Boolean(run?.finished_at && !terminalSucceeded);
  const implementation = terminalSucceeded ? implementationCompletion(runPayload) : null;
  const publication = implementation?.kind === 'changed' ? draftPublication(runPayload) : null;
  const notification = attempt
    ? notificationStatus({ attentionEvents, queueEvents, issueNumber: issue, attemptId: attempt.attempt_id, terminalSucceeded, runPayload })
    : 'missing';

  const checks = {
    claimPersisted: Boolean(claim),
    attemptPersisted: Boolean(attempt),
    workerStarted,
    terminalPersistence: terminalSucceeded,
    implementationEvidence: Boolean(implementation),
    draftPublication: implementation?.kind === 'no-change' || Boolean(publication),
    notificationSatisfied: ['delivered', 'not-required'].includes(notification),
    dashboardRefreshed: Boolean(run && attempt && dashboardContainsEvidence(dashboardSnapshot, {
      issueNumber: issue,
      attemptId: attempt.attempt_id,
      runResultId: run.id,
      finishedAt: run.finished_at,
    })),
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const passed = failedChecks.length === 0;

  return {
    schemaVersion: 'agent-runner-canary-proof/v2',
    issueNumber: issue,
    sourcePreflightComment,
    since,
    passed,
    state: terminalSucceeded ? 'terminal_success'
      : terminalFailed ? 'terminal_failure'
        : workerStarted ? 'worker_started'
          : attempt ? 'claim_persisted'
            : claim ? 'claim_persisted'
              : 'handled_noop',
    failedChecks,
    checks,
    evidence: {
      claimId: claim?.id || null,
      attemptId: attempt?.attempt_id || null,
      runResultId: run?.id || null,
      startedAt: attempt?.started_at || run?.started_at || null,
      finishedAt: run?.finished_at || null,
      terminalOutcome: runPayload.terminalOutcome || attempt?.outcome || null,
      implementation,
      publication,
      notification,
      dashboardGeneratedAt: dashboardSnapshot?.generatedAt || dashboardSnapshot?.refreshedAt || null,
    },
    safeNextAction: passed
      ? 'Proceed to supervised reboot and recurrence proof; keep the execution timer disabled until that gate also passes.'
      : 'Do not enable the execution timer. Resolve the failed correlated canary evidence checks before another acceptance attempt.',
  };
}

export function inspectCanaryProof(store, options = {}) {
  if (!store?.db) throw new Error('runner state store with database access is required');
  return evaluateCanaryProof({
    ...options,
    claims: store.db.prepare('SELECT * FROM claims WHERE issue_number = ? ORDER BY created_at, id').all(options.issueNumber),
    recoveryAttempts: store.db.prepare('SELECT * FROM recovery_attempts WHERE issue_number = ? ORDER BY started_at, attempt_id').all(options.issueNumber),
    runResults: store.db.prepare('SELECT * FROM run_results WHERE issue_number = ? ORDER BY created_at, id').all(options.issueNumber),
    queueEvents: store.db.prepare('SELECT * FROM queue_events WHERE issue_number = ? ORDER BY created_at, id').all(options.issueNumber),
    attentionEvents: store.db.prepare('SELECT * FROM attention_events WHERE issue_number = ? ORDER BY created_at, id').all(options.issueNumber),
  });
}

function parseDashboardSnapshot(path) {
  const text = readFileSync(path, 'utf8').trim();
  const direct = parseObject(text);
  if (direct) return direct;
  const match = text.match(/^\s*window\.RUNNER_DASHBOARD_DATA\s*=\s*([\s\S]*);\s*$/);
  const parsed = match ? parseObject(match[1]) : null;
  if (!parsed) throw new Error(`dashboard snapshot is not valid JSON or dashboard-data.js: ${path}`);
  return parsed;
}

export function canaryProofHelp() {
  return `Usage: node scripts/ops/agent-runner-canary-proof.mjs [options]\n\nRequired:\n  --issue <n>                         Issue number\n  --source-preflight-comment <id>     Exact typed manager-preflight comment identity\n  --since <ISO timestamp>             Earliest allowed evidence timestamp\n  --dashboard-snapshot <path>         JSON or dashboard-data.js snapshot\n\nOptions:\n  --project <id>                      Project id, default from config\n  --config <path>                     Agent Runner project config JSON\n  --state-db <path>                   Override configured SQLite state DB\n  -h, --help                          Show this help\n`;
}

export function parseCanaryProofArgs(argv = process.argv.slice(2), env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  const args = {
    project: config.projectId,
    issueNumber: null,
    sourcePreflightComment: null,
    since: null,
    dashboardSnapshotPath: null,
    stateDbPath: env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath,
    help: false,
    config,
  };
  const stripped = stripConfigArgs(argv);
  for (let index = 0; index < stripped.length; index += 1) {
    const arg = stripped[index];
    const next = () => {
      const value = stripped[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--project') args.project = next();
    else if (arg === '--issue') args.issueNumber = Number(next());
    else if (arg === '--source-preflight-comment') args.sourcePreflightComment = next();
    else if (arg === '--since') args.since = next();
    else if (arg === '--dashboard-snapshot') args.dashboardSnapshotPath = next();
    else if (arg === '--state-db' || arg === '--db') args.stateDbPath = next();
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!Number.isInteger(args.issueNumber) || args.issueNumber < 1) throw new Error('--issue must be a positive integer');
  if (!normalizeCommentIdentity(args.sourcePreflightComment, { context: 'canary-proof-cli-source' })) throw new Error('--source-preflight-comment must be a typed GitHub comment identity');
  if (timestamp(args.since) === null) throw new Error('--since must be a valid ISO timestamp');
  if (!args.dashboardSnapshotPath) throw new Error('--dashboard-snapshot is required');
  if (!args.stateDbPath) throw new Error('state DB path is required');
  return args;
}

export function runCanaryProofCli(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }, dependencies = {}) {
  let args;
  try {
    args = parseCanaryProofArgs(argv, env);
  } catch (error) {
    io.stderr.write(`${error.message}\n\n${canaryProofHelp()}`);
    return 2;
  }
  if (args.help) {
    io.stdout.write(canaryProofHelp());
    return 0;
  }

  const dashboardSnapshot = (dependencies.parseDashboardSnapshot || parseDashboardSnapshot)(args.dashboardSnapshotPath);
  const openDb = dependencies.openDb || ((path) => new DatabaseSync(path, { readOnly: true }));
  const db = openDb(args.stateDbPath);
  try {
    const result = inspectCanaryProof({ db }, {
      issueNumber: args.issueNumber,
      sourcePreflightComment: args.sourcePreflightComment,
      since: args.since,
      dashboardSnapshot,
    });
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.passed ? 0 : 1;
  } finally {
    db.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runCanaryProofCli();
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: 'agent-runner-canary-proof/v2',
      passed: false,
      systemicFailure: true,
      reason: String(error?.message || error),
      safeNextAction: 'Keep the execution timer disabled and repair the proof prerequisites.',
    }, null, 2));
    process.exitCode = 1;
  }
}
