#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';

export const INPUT_SCHEMA_VERSION = 'agent-runner-reliability-evidence/v1';
export const REPORT_SCHEMA_VERSION = 'agent-runner-reliability-acceptance-report/v1';
export const EXPECTED_REPOSITORY = 'TheTekTeam/agent-runner';
export const EXPECTED_ISSUE = 5;
export const EXECUTION_MODE = 'report-only';
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_ARRAY_ITEMS = 32;
export const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const MAX_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const GATE_IDS = Object.freeze([
  'repository_exact_head', 'checkout_clean', 'timer_preacceptance_disabled',
  'state_backup_recorded', 'state_schema_current', 'focused_validation_passed',
  'full_validation_passed', 'synthetic_notification_smoke_passed',
  'dashboard_refresh_correlated', 'negative_admission_zero_mutation',
  'repeated_refusal_no_queue_consumption', 'issue_skip_continues_scan',
  'task_local_failure_isolated', 'real_blocker_only_blocked',
  'supervised_canary_correlated', 'false_block_repair_verified',
  'repair_second_pass_idempotent', 'timer_recurrence_passed',
  'reboot_survival_passed', 'redaction_passed',
]);

export const REASON_CODES = Object.freeze([
  'passed', 'input_schema_invalid', 'input_read_failed', 'evidence_missing',
  'evidence_stale', 'evidence_future_dated', 'repository_mismatch',
  'head_mismatch', 'checkout_dirty', 'timer_not_disabled',
  'service_state_invalid', 'backup_identity_mismatch', 'schema_mismatch',
  'validation_failed', 'notification_unproven', 'dashboard_uncorrelated',
  'state_db_mismatch', 'unexpected_mutation', 'candidate_consumed',
  'scan_not_continued', 'task_failure_not_isolated', 'unsafe_blocked_status',
  'issue_mismatch', 'attempt_mismatch', 'authority_mismatch',
  'canary_uncorrelated', 'exit_code_only', 'repair_not_deterministic',
  'repair_not_idempotent', 'recurrence_unproven', 'reboot_unproven',
  'redaction_failed', 'contradictory_evidence',
]);

const REASONS = new Set(REASON_CODES);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/;
const FP = /^sha256:[0-9a-f]{64}$/;
const REV = /^[A-Z0-9][A-Z0-9._:-]{0,127}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REDACTION_CASES = Object.freeze([
  'credentials', 'environment_values', 'exception_messages',
  'full_issue_bodies', 'local_secret_paths', 'prompts', 'provider_output',
  'raw_logs', 'restricted_handles',
]);

const ACTION = Object.freeze({
  repository_exact_head: 'Deploy and recapture evidence for the authorised exact repository head.',
  checkout_clean: 'Clean or replace the deployed checkout, then recapture read-only evidence.',
  timer_preacceptance_disabled: 'Disable the execution timer without changing queue state, then recapture pre-acceptance evidence.',
  state_backup_recorded: 'Create and verify a read-only identity record for the pre-acceptance SQLite backup.',
  state_schema_current: 'Migrate the copied state through the authorised process, then recapture schema evidence.',
  focused_validation_passed: 'Run the authorised focused parser, correlation, stale-evidence, fault-injection and redaction tests on the exact head.',
  full_validation_passed: 'Run node check, npm test, npm run validate and git diff check on the exact head.',
  synthetic_notification_smoke_passed: 'Repeat the synthetic capture-transport smoke without enabling a real transport.',
  dashboard_refresh_correlated: 'Republish and recapture the bounded dashboard snapshot for the same event, issue, attempt and head.',
  negative_admission_zero_mutation: 'Repeat the negative admission proof with before-and-after identities and zero durable mutations.',
  repeated_refusal_no_queue_consumption: 'Repeat the unchanged refusal and prove the next candidate remains unconsumed.',
  issue_skip_continues_scan: 'Repeat the issue-local skip and prove scanning continues to an unrelated eligible issue.',
  task_local_failure_isolated: 'Repeat the task-local failure and prove healthy service semantics with no unrelated issue block.',
  real_blocker_only_blocked: 'Remove any blocked transition not backed by a genuine work-item blocker and recapture the audit.',
  supervised_canary_correlated: 'Keep the execution timer disabled and repeat one bounded canary with one fully correlated evidence chain.',
  false_block_repair_verified: 'Re-run the deterministic repair proposal and capture the exact eligible and applied set.',
  repair_second_pass_idempotent: 'Run a second repair pass and prove it proposes and applies no further changes.',
  timer_recurrence_passed: 'Capture at least two distinct scheduled triggers and service runs on the exact head.',
  reboot_survival_passed: 'Repeat the controlled reboot proof and capture a distinct boot plus a post-boot scheduled run.',
  redaction_passed: 'Run the serialized adversarial-redaction suite and resolve every detected leak before acceptance.',
});

class SchemaError extends Error {}
const obj = (v) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SchemaError(); return v; };
const keys = (v, expected) => {
  obj(v);
  const actual = Object.keys(v).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) throw new SchemaError();
};
const str = (v, pattern = ID) => { if (typeof v !== 'string' || !pattern.test(v)) throw new SchemaError(); return v; };
const bool = (v) => { if (typeof v !== 'boolean') throw new SchemaError(); return v; };
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isInteger(v) || v < min || v > max) throw new SchemaError(); return v; };
const oneOf = (v, allowed) => { if (!allowed.includes(v)) throw new SchemaError(); return v; };
const time = (v) => { if (typeof v !== 'string' || v.length > 40 || !Number.isFinite(Date.parse(v))) throw new SchemaError(); return v; };
const array = (v, check, min = 0, max = MAX_ARRAY_ITEMS) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new SchemaError();
  v.forEach(check); return v;
};
const baseKeys = ({ state = false, issue = false, attempt = false } = {}) => [
  'evidenceId', 'capturedAt', 'head', ...(state ? ['stateDbId'] : []),
  ...(issue ? ['issueNumber'] : []), ...(attempt ? ['attemptId'] : []),
];
const common = (v, options = {}) => {
  str(v.evidenceId); time(v.capturedAt); str(v.head, SHA);
  if (options.state) str(v.stateDbId);
  if (options.issue) integer(v.issueNumber, 1, 1_000_000_000);
  if (options.attempt) str(v.attemptId);
};
const exact = (v, extra, options = {}) => { keys(v, [...baseKeys(options), ...extra]); common(v, options); };
const count = (v) => integer(v, 0, 1_000_000);

function validateValidation(v) {
  exact(v, ['status', 'total', 'passed', 'failed', 'skipped', 'assertions']);
  oneOf(v.status, ['passed', 'failed']);
  count(v.total); count(v.passed); count(v.failed); count(v.skipped);
  array(v.assertions, (x) => str(x), 1, 16);
}

function validateCanary(v) {
  exact(v, ['managerPacket', 'claim', 'workerStart', 'repositoryChange', 'draftPr', 'terminal', 'notification', 'dashboard'], { state: true, issue: true, attempt: true });
  exact(v.managerPacket, ['revision', 'fingerprint'], { issue: true, attempt: true });
  str(v.managerPacket.revision, REV); str(v.managerPacket.fingerprint, FP);
  exact(v.claim, ['revision', 'fingerprint'], { state: true, issue: true, attempt: true });
  str(v.claim.revision, REV); str(v.claim.fingerprint, FP);
  exact(v.workerStart, ['revision', 'fingerprint', 'started'], { state: true, issue: true, attempt: true });
  str(v.workerStart.revision, REV); str(v.workerStart.fingerprint, FP); bool(v.workerStart.started);
  exact(v.repositoryChange, ['commitSha', 'changedFiles'], { state: true, issue: true, attempt: true });
  str(v.repositoryChange.commitSha, SHA); integer(v.repositoryChange.changedFiles, 0, 100_000);
  exact(v.draftPr, ['commitSha', 'prNumber', 'draft'], { state: true, issue: true, attempt: true });
  str(v.draftPr.commitSha, SHA); integer(v.draftPr.prNumber, 1, 1_000_000_000); bool(v.draftPr.draft);
  exact(v.terminal, ['outcome', 'durable', 'exitCode', 'runResultId'], { state: true, issue: true, attempt: true });
  oneOf(v.terminal.outcome, ['completed', 'failed', 'attention']); bool(v.terminal.durable);
  integer(v.terminal.exitCode, 0, 255); str(v.terminal.runResultId);
  exact(v.notification, ['disposition', 'notificationEventId'], { state: true, issue: true, attempt: true });
  oneOf(v.notification.disposition, ['delivered', 'not-required', 'missing']); str(v.notification.notificationEventId);
  exact(v.dashboard, ['generatedAt', 'runResultId', 'notificationEventId'], { state: true, issue: true, attempt: true });
  time(v.dashboard.generatedAt); str(v.dashboard.runResultId); str(v.dashboard.notificationEventId);
}

function validateBundle(v) {
  keys(v, ['schemaVersion', 'acceptanceId', 'repository', 'issueNumber', 'expectedHead', 'deployedHead', 'stateDbId', 'stateSchemaVersion', 'windowStartedAt', 'windowEndedAt', 'records']);
  if (v.schemaVersion !== INPUT_SCHEMA_VERSION) throw new SchemaError();
  str(v.acceptanceId); str(v.repository, REPO); integer(v.issueNumber, 1, 1_000_000_000);
  str(v.expectedHead, SHA); str(v.deployedHead, SHA); str(v.stateDbId);
  integer(v.stateSchemaVersion, 1, 10_000); time(v.windowStartedAt); time(v.windowEndedAt);
  const r = obj(v.records);
  keys(r, ['repository', 'timer', 'backup', 'focusedValidation', 'fullValidation', 'notification', 'dashboard', 'negativeAdmission', 'repeatedRefusal', 'issueSkip', 'taskFailure', 'blockerAudit', 'canary', 'repair', 'recurrence', 'reboot', 'redaction']);

  exact(r.repository, ['repository', 'clean']); str(r.repository.repository, REPO); bool(r.repository.clean);
  exact(r.timer, ['phase', 'serviceState', 'timerEnabled', 'timerActive']);
  oneOf(r.timer.phase, ['preacceptance']); oneOf(r.timer.serviceState, ['inactive', 'active']); bool(r.timer.timerEnabled); bool(r.timer.timerActive);
  exact(r.backup, ['backupId', 'backupStateDbId', 'schemaVersion', 'backupSchemaVersion', 'consistent'], { state: true });
  str(r.backup.backupId); str(r.backup.backupStateDbId); integer(r.backup.schemaVersion, 1, 10_000); integer(r.backup.backupSchemaVersion, 1, 10_000); bool(r.backup.consistent);
  validateValidation(r.focusedValidation); validateValidation(r.fullValidation);

  exact(r.notification, ['synthetic', 'transport', 'eventType', 'deliveryStatus', 'notificationEventId'], { state: true, issue: true, attempt: true });
  bool(r.notification.synthetic); oneOf(r.notification.transport, ['synthetic-capture']);
  oneOf(r.notification.eventType, ['completed', 'failed_attention', 'quota_blocked', 'agent_reassigned', 'no_qualified_agent', 'systemic_pause']);
  oneOf(r.notification.deliveryStatus, ['delivered', 'pending', 'retryable-failed', 'exhausted', 'resolved']); str(r.notification.notificationEventId);
  exact(r.dashboard, ['generatedAt', 'notificationEventId', 'runResultId', 'containsNotification', 'containsRun'], { state: true, issue: true, attempt: true });
  time(r.dashboard.generatedAt); str(r.dashboard.notificationEventId); str(r.dashboard.runResultId); bool(r.dashboard.containsNotification); bool(r.dashboard.containsRun);

  exact(r.negativeAdmission, ['profileFingerprintId', 'refusalReason', 'beforeGithubIdentityId', 'afterGithubIdentityId', 'claimDelta', 'attemptDelta', 'workerStartDelta', 'githubMutationDelta'], { state: true });
  str(r.negativeAdmission.profileFingerprintId); oneOf(r.negativeAdmission.refusalReason, ['machine_profile', 'systemic']);
  str(r.negativeAdmission.beforeGithubIdentityId); str(r.negativeAdmission.afterGithubIdentityId);
  ['claimDelta', 'attemptDelta', 'workerStartDelta', 'githubMutationDelta'].forEach((k) => count(r.negativeAdmission[k]));
  exact(r.repeatedRefusal, ['profileFingerprintId', 'refusalReason', 'refusalCount', 'nextCandidateId', 'nextCandidateConsumed', 'claimDelta', 'attemptDelta', 'workerStartDelta', 'githubMutationDelta'], { state: true });
  str(r.repeatedRefusal.profileFingerprintId); oneOf(r.repeatedRefusal.refusalReason, ['machine_profile', 'systemic']);
  integer(r.repeatedRefusal.refusalCount, 1, 100); str(r.repeatedRefusal.nextCandidateId); bool(r.repeatedRefusal.nextCandidateConsumed);
  ['claimDelta', 'attemptDelta', 'workerStartDelta', 'githubMutationDelta'].forEach((k) => count(r.repeatedRefusal[k]));

  exact(r.issueSkip, ['skippedIssueNumber', 'skipReason', 'continuedIssueNumber', 'continuedCandidateSelected', 'skippedClaimDelta', 'skippedGithubMutationDelta'], { state: true });
  integer(r.issueSkip.skippedIssueNumber, 1, 1_000_000_000); oneOf(r.issueSkip.skipReason, ['issue_not_runnable']);
  integer(r.issueSkip.continuedIssueNumber, 1, 1_000_000_000); bool(r.issueSkip.continuedCandidateSelected); count(r.issueSkip.skippedClaimDelta); count(r.issueSkip.skippedGithubMutationDelta);
  exact(r.taskFailure, ['scope', 'serviceExitCode', 'systemdResult', 'unrelatedIssueNumber', 'unrelatedIssueStatusPreserved', 'blockedMutation'], { state: true, issue: true, attempt: true });
  oneOf(r.taskFailure.scope, ['task_attempt']); integer(r.taskFailure.serviceExitCode, 0, 255); oneOf(r.taskFailure.systemdResult, ['success', 'failed']);
  integer(r.taskFailure.unrelatedIssueNumber, 1, 1_000_000_000); bool(r.taskFailure.unrelatedIssueStatusPreserved); bool(r.taskFailure.blockedMutation);
  exact(r.blockerAudit, ['entries'], { state: true });
  array(r.blockerAudit.entries, (e) => {
    keys(e, ['evidenceId', 'issueNumber', 'scope', 'blockedApplied', 'realBlockerEvidenceId']);
    str(e.evidenceId); integer(e.issueNumber, 1, 1_000_000_000);
    oneOf(e.scope, ['systemic', 'machine_profile', 'issue_not_runnable', 'task_attempt', 'completed']); bool(e.blockedApplied);
    if (e.realBlockerEvidenceId !== null) str(e.realBlockerEvidenceId);
  }, 1);

  validateCanary(r.canary);
  exact(r.repair, ['incidentId', 'firstPass', 'secondPass'], { state: true }); str(r.repair.incidentId);
  for (const [name, p] of Object.entries({ firstPass: r.repair.firstPass, secondPass: r.repair.secondPass })) {
    keys(p, ['evidenceId', 'proposalDigestId', 'eligibleCount', 'appliedCount', 'restoredIssueNumbers', 'deterministic', ...(name === 'secondPass' ? ['noChanges'] : [])]);
    str(p.evidenceId); str(p.proposalDigestId); integer(p.eligibleCount, 0, 100_000); integer(p.appliedCount, 0, 100_000);
    array(p.restoredIssueNumbers, (n) => integer(n, 1, 1_000_000_000)); bool(p.deterministic); if (name === 'secondPass') bool(p.noChanges);
  }
  exact(r.recurrence, ['timerUnitId', 'triggerIds', 'runIds', 'triggeredAt', 'enabled'], { state: true });
  str(r.recurrence.timerUnitId); array(r.recurrence.triggerIds, (x) => str(x), 2, 16); array(r.recurrence.runIds, (x) => str(x), 2, 16); array(r.recurrence.triggeredAt, (x) => time(x), 2, 16); bool(r.recurrence.enabled);
  exact(r.reboot, ['beforeBootId', 'afterBootId', 'postBootTriggerId', 'postBootRunId', 'unitEnabled', 'serviceHealthy'], { state: true });
  str(r.reboot.beforeBootId); str(r.reboot.afterBootId); str(r.reboot.postBootTriggerId); str(r.reboot.postBootRunId); bool(r.reboot.unitEnabled); bool(r.reboot.serviceHealthy);
  exact(r.redaction, ['fixtureSetId', 'serializedOutputDigestId', 'cases', 'leakCount', 'serialized']);
  str(r.redaction.fixtureSetId); str(r.redaction.serializedOutputDigestId); array(r.redaction.cases, (x) => str(x), 1, 16); count(r.redaction.leakCount); bool(r.redaction.serialized);
  return v;
}

const ms = (v) => Date.parse(v);
const unique = (v) => new Set(v).size === v.length;
const ids = (...v) => v.flat(Infinity).filter(Boolean).map((x) => x.evidenceId).filter(Boolean).slice(0, 8);
const result = (id, passed, reason, evidenceIds = []) => ({
  id, passed: Boolean(passed), reasonCode: passed ? 'passed' : (REASONS.has(reason) ? reason : 'contradictory_evidence'),
  evidenceIds: [...evidenceIds], safeNextAction: passed ? 'No action required for this gate.' : ACTION[id],
});
const recordReason = (record, c, options = {}) => {
  if (!record) return 'evidence_missing';
  const at = ms(record.capturedAt);
  if (at > c.now) return 'evidence_future_dated';
  if (at < c.start || at > c.end) return 'evidence_stale';
  if (record.head !== c.head) return 'head_mismatch';
  if (options.state && record.stateDbId !== c.stateDbId) return 'state_db_mismatch';
  if (options.issue && Number(record.issueNumber) !== Number(c.issueNumber)) return 'issue_mismatch';
  if (options.attempt && String(record.attemptId) !== String(c.attemptId)) return 'attempt_mismatch';
  return null;
};
const anyReason = (records, c, options) => records.map((r) => recordReason(r, c, options)).find(Boolean) || null;

function buildReport(bundle, gates, evaluatedAt) {
  const passed = gates.filter((g) => g.passed).length;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION, mode: EXECUTION_MODE,
    passed: passed === GATE_IDS.length, acceptanceId: bundle?.acceptanceId || null,
    repository: bundle?.repository || null,
    issueNumber: Number.isInteger(bundle?.issueNumber) ? bundle.issueNumber : null,
    deployedHead: SHA.test(bundle?.deployedHead || '') ? bundle.deployedHead : null,
    evaluatedAt, summary: { required: GATE_IDS.length, passed, failed: GATE_IDS.length - passed }, gates,
  };
}

export function invalidReport(reasonCode = 'input_schema_invalid', now = new Date().toISOString()) {
  const at = Number.isFinite(Date.parse(now)) ? new Date(now).toISOString() : new Date(0).toISOString();
  return buildReport(null, GATE_IDS.map((id) => result(id, false, reasonCode)), at);
}

export function evaluateReliabilityAcceptance(input, { expectedHead, now = new Date().toISOString(), maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS } = {}) {
  let b;
  try {
    b = validateBundle(structuredClone(input)); str(expectedHead, SHA); time(now); integer(maxAgeSeconds, 1, MAX_MAX_AGE_SECONDS);
  } catch { return invalidReport('input_schema_invalid', now); }
  const nowMs = ms(now), start = ms(b.windowStartedAt), end = ms(b.windowEndedAt);
  const global = start > end ? 'contradictory_evidence'
    : end > nowMs ? 'evidence_future_dated'
      : nowMs - end > maxAgeSeconds * 1000 ? 'evidence_stale'
        : expectedHead !== b.expectedHead || b.expectedHead !== b.deployedHead ? 'head_mismatch'
          : b.repository !== EXPECTED_REPOSITORY ? 'repository_mismatch'
            : b.issueNumber !== EXPECTED_ISSUE ? 'issue_mismatch' : null;
  const r = b.records;
  const c = { head: b.deployedHead, stateDbId: b.stateDbId, issueNumber: b.issueNumber, attemptId: null, start, end, now: nowMs };
  const gates = [];
  const add = (id, evidence, fn) => gates.push(global ? result(id, false, global, ids(evidence)) : fn());

  add('repository_exact_head', r.repository, () => {
    const why = recordReason(r.repository, c); const pass = !why && r.repository.repository === b.repository && r.repository.head === expectedHead;
    return result('repository_exact_head', pass, why || 'repository_mismatch', ids(r.repository));
  });
  add('checkout_clean', r.repository, () => { const why = recordReason(r.repository, c); return result('checkout_clean', !why && r.repository.clean, why || 'checkout_dirty', ids(r.repository)); });
  add('timer_preacceptance_disabled', r.timer, () => {
    const why = recordReason(r.timer, c);
    if (!why && r.timer.serviceState === 'active') return result('timer_preacceptance_disabled', false, 'service_state_invalid', ids(r.timer));
    return result('timer_preacceptance_disabled', !why && !r.timer.timerEnabled && !r.timer.timerActive, why || 'timer_not_disabled', ids(r.timer));
  });
  add('state_backup_recorded', r.backup, () => {
    const why = recordReason(r.backup, c, { state: true });
    const pass = !why && r.backup.consistent && r.backup.backupStateDbId === b.stateDbId && r.backup.backupId !== b.stateDbId;
    return result('state_backup_recorded', pass, why || 'backup_identity_mismatch', ids(r.backup));
  });
  add('state_schema_current', r.backup, () => {
    const why = recordReason(r.backup, c, { state: true });
    const pass = !why
      && b.stateSchemaVersion === RUNNER_STATE_SCHEMA_VERSION
      && r.backup.schemaVersion === RUNNER_STATE_SCHEMA_VERSION
      && r.backup.backupSchemaVersion === RUNNER_STATE_SCHEMA_VERSION;
    return result('state_schema_current', pass, why || 'schema_mismatch', ids(r.backup));
  });
  const validation = (id, v, required) => {
    const why = recordReason(v, c); const set = new Set(v.assertions);
    const pass = !why && v.status === 'passed' && v.failed === 0 && v.passed > 0 && v.total === v.passed + v.failed + v.skipped && required.every((x) => set.has(x));
    return result(id, pass, why || 'validation_failed', ids(v));
  };
  add('focused_validation_passed', r.focusedValidation, () => validation('focused_validation_passed', r.focusedValidation, ['parser', 'correlation', 'stale_evidence', 'fault_injection', 'adversarial_redaction']));
  add('full_validation_passed', r.fullValidation, () => validation('full_validation_passed', r.fullValidation, ['node_check', 'npm_test', 'npm_validate', 'diff_check']));
  add('synthetic_notification_smoke_passed', r.notification, () => {
    const why = recordReason(r.notification, c, { state: true });
    return result('synthetic_notification_smoke_passed', !why && r.notification.synthetic && r.notification.transport === 'synthetic-capture' && r.notification.deliveryStatus === 'delivered', why || 'notification_unproven', ids(r.notification));
  });
  add('dashboard_refresh_correlated', [r.notification, r.dashboard], () => {
    const why = recordReason(r.notification, c, { state: true }) || recordReason(r.dashboard, c, { state: true });
    const pass = !why && r.dashboard.issueNumber === r.notification.issueNumber && r.dashboard.attemptId === r.notification.attemptId
      && r.dashboard.notificationEventId === r.notification.notificationEventId && r.dashboard.containsNotification && r.dashboard.containsRun
      && ms(r.dashboard.generatedAt) >= ms(r.notification.capturedAt);
    return result('dashboard_refresh_correlated', pass, why || 'dashboard_uncorrelated', ids(r.notification, r.dashboard));
  });
  add('negative_admission_zero_mutation', r.negativeAdmission, () => {
    const why = recordReason(r.negativeAdmission, c, { state: true });
    const zero = ['claimDelta', 'attemptDelta', 'workerStartDelta', 'githubMutationDelta'].every((k) => r.negativeAdmission[k] === 0);
    return result('negative_admission_zero_mutation', !why && zero && r.negativeAdmission.beforeGithubIdentityId === r.negativeAdmission.afterGithubIdentityId, why || 'unexpected_mutation', ids(r.negativeAdmission));
  });
  add('repeated_refusal_no_queue_consumption', [r.negativeAdmission, r.repeatedRefusal], () => {
    const why = recordReason(r.negativeAdmission, c, { state: true }) || recordReason(r.repeatedRefusal, c, { state: true });
    const zero = ['claimDelta', 'attemptDelta', 'workerStartDelta', 'githubMutationDelta'].every((k) => r.repeatedRefusal[k] === 0);
    const pass = !why && r.repeatedRefusal.profileFingerprintId === r.negativeAdmission.profileFingerprintId
      && r.repeatedRefusal.refusalReason === r.negativeAdmission.refusalReason && r.repeatedRefusal.refusalCount >= 2
      && !r.repeatedRefusal.nextCandidateConsumed && zero;
    return result('repeated_refusal_no_queue_consumption', pass, why || (r.repeatedRefusal.nextCandidateConsumed ? 'candidate_consumed' : 'unexpected_mutation'), ids(r.negativeAdmission, r.repeatedRefusal));
  });
  add('issue_skip_continues_scan', r.issueSkip, () => {
    const why = recordReason(r.issueSkip, c, { state: true });
    const pass = !why && r.issueSkip.skippedIssueNumber !== r.issueSkip.continuedIssueNumber && r.issueSkip.continuedCandidateSelected
      && r.issueSkip.skippedClaimDelta === 0 && r.issueSkip.skippedGithubMutationDelta === 0;
    return result('issue_skip_continues_scan', pass, why || 'scan_not_continued', ids(r.issueSkip));
  });
  add('task_local_failure_isolated', r.taskFailure, () => {
    const why = recordReason(r.taskFailure, c, { state: true });
    const pass = !why && r.taskFailure.serviceExitCode === 0 && r.taskFailure.systemdResult === 'success'
      && r.taskFailure.unrelatedIssueNumber !== r.taskFailure.issueNumber && r.taskFailure.unrelatedIssueStatusPreserved && !r.taskFailure.blockedMutation;
    return result('task_local_failure_isolated', pass, why || 'task_failure_not_isolated', ids(r.taskFailure));
  });
  add('real_blocker_only_blocked', r.blockerAudit, () => {
    const why = recordReason(r.blockerAudit, c, { state: true });
    const safe = r.blockerAudit.entries.every((e) => e.blockedApplied
      ? e.scope === 'issue_not_runnable' && Boolean(e.realBlockerEvidenceId)
      : e.realBlockerEvidenceId === null || e.scope === 'issue_not_runnable');
    return result('real_blocker_only_blocked', !why && safe, why || 'unsafe_blocked_status', ids(r.blockerAudit, r.blockerAudit.entries));
  });
  add('supervised_canary_correlated', r.canary, () => {
    const v = r.canary, cc = { ...c, issueNumber: v.issueNumber, attemptId: v.attemptId };
    const parts = [v, v.managerPacket, v.claim, v.workerStart, v.repositoryChange, v.draftPr, v.terminal, v.notification, v.dashboard];
    const why = recordReason(v, cc, { state: true, issue: true, attempt: true })
      || recordReason(v.managerPacket, cc, { issue: true, attempt: true })
      || anyReason(parts.slice(2), cc, { state: true, issue: true, attempt: true });
    if (why) return result('supervised_canary_correlated', false, why, ids(parts));
    const authority = v.managerPacket.revision === v.claim.revision && v.managerPacket.revision === v.workerStart.revision
      && v.managerPacket.fingerprint === v.claim.fingerprint && v.managerPacket.fingerprint === v.workerStart.fingerprint;
    if (!authority) return result('supervised_canary_correlated', false, 'authority_mismatch', ids(parts));
    if (v.terminal.exitCode === 0 && (!v.terminal.durable || v.terminal.outcome !== 'completed')) return result('supervised_canary_correlated', false, 'exit_code_only', ids(parts));
    const sequence = parts.slice(1).map((x) => ms(x.capturedAt));
    const ordered = sequence.every((x, i) => i === 0 || x >= sequence[i - 1]);
    const pass = ordered && v.workerStart.started && v.repositoryChange.changedFiles > 0 && v.draftPr.draft
      && v.draftPr.commitSha === v.repositoryChange.commitSha && v.terminal.durable && v.terminal.outcome === 'completed'
      && v.notification.disposition === 'delivered' && v.dashboard.runResultId === v.terminal.runResultId
      && v.dashboard.notificationEventId === v.notification.notificationEventId && ms(v.dashboard.generatedAt) >= ms(v.terminal.capturedAt);
    return result('supervised_canary_correlated', pass, ordered ? 'canary_uncorrelated' : 'contradictory_evidence', ids(parts));
  });
  add('false_block_repair_verified', r.repair, () => {
    const why = recordReason(r.repair, c, { state: true }), p = r.repair.firstPass;
    const pass = !why && p.deterministic && p.eligibleCount > 0 && p.appliedCount === p.eligibleCount
      && p.restoredIssueNumbers.length === p.appliedCount && unique(p.restoredIssueNumbers);
    return result('false_block_repair_verified', pass, why || 'repair_not_deterministic', ids(r.repair, p));
  });
  add('repair_second_pass_idempotent', r.repair, () => {
    const why = recordReason(r.repair, c, { state: true }), p = r.repair.secondPass;
    const pass = !why && p.deterministic && p.noChanges && p.eligibleCount === 0 && p.appliedCount === 0 && p.restoredIssueNumbers.length === 0;
    return result('repair_second_pass_idempotent', pass, why || 'repair_not_idempotent', ids(r.repair, p));
  });
  add('timer_recurrence_passed', r.recurrence, () => {
    const why = recordReason(r.recurrence, c, { state: true }), times = r.recurrence.triggeredAt.map(ms);
    const ordered = times.every((x, i) => i === 0 || x > times[i - 1]);
    const pass = !why && r.recurrence.enabled && r.recurrence.triggerIds.length >= 2
      && r.recurrence.triggerIds.length === r.recurrence.runIds.length && r.recurrence.runIds.length === times.length
      && unique(r.recurrence.triggerIds) && unique(r.recurrence.runIds) && ordered;
    return result('timer_recurrence_passed', pass, why || 'recurrence_unproven', ids(r.recurrence));
  });
  add('reboot_survival_passed', r.reboot, () => {
    const why = recordReason(r.reboot, c, { state: true });
    const pass = !why && r.reboot.beforeBootId !== r.reboot.afterBootId && r.reboot.unitEnabled && r.reboot.serviceHealthy
      && ms(r.reboot.capturedAt) >= ms(r.recurrence.capturedAt);
    return result('reboot_survival_passed', pass, why || 'reboot_unproven', ids(r.reboot));
  });
  add('redaction_passed', r.redaction, () => {
    const why = recordReason(r.redaction, c); const cases = [...r.redaction.cases].sort();
    const pass = !why && r.redaction.serialized && r.redaction.leakCount === 0 && JSON.stringify(cases) === JSON.stringify(REDACTION_CASES);
    return result('redaction_passed', pass, why || 'redaction_failed', ids(r.redaction));
  });
  return buildReport(b, gates, new Date(now).toISOString());
}

export function reliabilityAcceptanceHelp() {
  return `Usage: node scripts/ops/agent-runner-reliability-acceptance.mjs --evidence <file> --expected-head <sha> [options]\n\nRequired:\n  --evidence <file>          Bounded JSON evidence bundle\n  --expected-head <sha>      Exact 40-character deployed repository head\n\nOptions:\n  --now <ISO timestamp>      Deterministic evaluation time\n  --max-age-seconds <n>      Maximum age of the acceptance window; default 604800\n  --help                     Show this help\n`;
}

export function parseReliabilityAcceptanceArgs(argv = process.argv.slice(2)) {
  const out = { evidencePath: null, expectedHead: null, now: new Date().toISOString(), maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { const v = argv[i + 1]; if (!v || v.startsWith('--')) throw new SchemaError(); i += 1; return v; };
    if (arg === '--evidence') out.evidencePath = next();
    else if (arg === '--expected-head') out.expectedHead = next();
    else if (arg === '--now') out.now = next();
    else if (arg === '--max-age-seconds') out.maxAgeSeconds = Number(next());
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new SchemaError();
  }
  if (out.help) return out;
  if (!out.evidencePath) throw new SchemaError();
  str(out.expectedHead, SHA); time(out.now); integer(out.maxAgeSeconds, 1, MAX_MAX_AGE_SECONDS);
  return out;
}

export function runReliabilityAcceptanceCli(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }, dependencies = {}) {
  let args;
  try { args = parseReliabilityAcceptanceArgs(argv); }
  catch { io.stdout.write(`${JSON.stringify(invalidReport('input_schema_invalid'), null, 2)}\n`); return 2; }
  if (args.help) { io.stdout.write(reliabilityAcceptanceHelp()); return 0; }
  try {
    const stat = (dependencies.stat || statSync)(args.evidencePath);
    if (!stat?.isFile?.() || stat.size < 2 || stat.size > MAX_INPUT_BYTES) throw new SchemaError();
    const parsed = JSON.parse((dependencies.readFile || readFileSync)(args.evidencePath, 'utf8'));
    const report = evaluateReliabilityAcceptance(parsed, args);
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.passed ? 0 : 1;
  } catch {
    io.stdout.write(`${JSON.stringify(invalidReport('input_read_failed', args.now), null, 2)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runReliabilityAcceptanceCli();
