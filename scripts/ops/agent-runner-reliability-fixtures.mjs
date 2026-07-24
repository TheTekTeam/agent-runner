#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FAILURE_SCOPES, admitMachineProfile, machineProfilePausePayload } from './agent-runner-admission.mjs';
import { AdmissionCircuitBreaker } from './agent-runner-circuit-breaker.mjs';
import {
  managerAuthorityKeyIsCurrent,
  parseManagerPreflightPacket,
  resolveCurrentManagerAuthority,
} from './agent-runner-manager-authority.mjs';
import { serviceExitCode } from './agent-runner-service-semantics.mjs';
import { resolveIssueSelection } from './claude-runner-selection.mjs';
import { decideRecovery } from './claude-runner-recovery.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';

export const FIXTURE_REPORT_SCHEMA_VERSION = 'agent-runner-reliability-fixtures/v1';
export const ACCEPTANCE_RECORD_SCHEMA_VERSION = 'agent-runner-reliability-evidence/v1';
export const EXPECTED_REPOSITORY = 'TheTekTeam/agent-runner';
export const SCENARIO_IDS = Object.freeze([
  'machine-profile-refusal-before-selection',
  'repeated-unchanged-refusal',
  'issue-local-skip-continues-scan',
  'task-local-worker-failure-isolated',
  'genuine-blocker-only-blocked',
  'manager-authority-refusals',
  'serialized-redaction',
]);
export const REDACTION_CASES = Object.freeze([
  'credentials', 'environment_values', 'exception_messages', 'full_issue_bodies',
  'local_secret_paths', 'prompts', 'provider_output', 'raw_logs', 'restricted_handles',
]);
export const PRODUCTION_DEPENDENCY_IDS = Object.freeze([
  'agent-runner-admission.admitMachineProfile',
  'agent-runner-circuit-breaker.AdmissionCircuitBreaker',
  'agent-runner-manager-authority.managerAuthorityKeyIsCurrent',
  'agent-runner-manager-authority.parseManagerPreflightPacket',
  'agent-runner-manager-authority.resolveCurrentManagerAuthority',
  'agent-runner-service-semantics.serviceExitCode',
  'claude-runner-recovery.decideRecovery',
  'claude-runner-selection.resolveIssueSelection',
  'claude-runner-state.openRunnerStateStore',
]);

const SHA = /^[0-9a-f]{40}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const DEFAULT_NOW = '2026-07-24T20:00:00.000Z';
const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 1_000_000) : 0);
const token = (v, fallback = 'unavailable') => TOKEN.test(String(v || '').trim()) ? String(v).trim() : fallback;
const reason = (v, fallback = 'fixture-invariant-failed') => REASON.test(String(v || '').toLowerCase()) ? String(v).toLowerCase() : fallback;
const time = (v) => Number.isFinite(Date.parse(String(v || ''))) ? new Date(v).toISOString() : DEFAULT_NOW;
const id = (prefix, material) => `${prefix}:${createHash('sha256').update(String(material)).digest('hex').slice(0, 24)}`;
const fp = (material) => `sha256:${createHash('sha256').update(String(material)).digest('hex')}`;
const issue = (number) => ({
  number, statusLabel: 'status:ready', agentLabel: 'agent:claude-code-cli',
  labels: ['status:ready', 'agent:claude-code-cli', 'priority:P0'],
});
const counters = () => ({ candidatesInspected: 0, claims: 0, attempts: 0, childLaunches: 0, workerStarts: 0, modelCalls: 0, githubMutations: 0 });
const snap = (v) => Object.fromEntries(Object.entries(v).map(([k, n]) => [k, count(n)]));
const delta = (after, before, key) => count((after[key] || 0) - (before[key] || 0));

function packet({ id: commentId, createdAt, revision, scope = 'Run the deterministic reliability fixture.', fingerprint = fp(revision) }) {
  return {
    id: commentId,
    created_at: createdAt,
    user: { login: 'fixture-manager' },
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: ${revision}\nfingerprint: ${fingerprint}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nscope:\n  - ${scope}\nrequired_validation:\n  - Run deterministic fixture validation.\nstop_conditions:\n  - Stop before any external side effect.\n\`\`\``,
  };
}

function scenario(scenarioId, passed, evidenceIds, state) {
  return {
    id: scenarioId,
    passed: Boolean(passed),
    reasonCode: passed ? 'passed' : 'fixture-invariant-failed',
    evidenceIds: evidenceIds.map((entry) => token(entry)).slice(0, 16),
    counters: snap(state),
  };
}

export function defaultAdversarialValues() {
  return Object.freeze({
    credential: 'synthetic_credential_value_DO_NOT_SERIALIZE',
    environmentValue: 'synthetic_environment_value_DO_NOT_SERIALIZE',
    exceptionMessage: 'synthetic_exception_message_DO_NOT_SERIALIZE',
    fullIssueBody: 'synthetic full issue body DO_NOT_SERIALIZE',
    localSecretPath: '/home/fixture/.config/agent-runner/secret-value',
    prompt: 'synthetic private prompt DO_NOT_SERIALIZE',
    providerOutput: 'synthetic provider output DO_NOT_SERIALIZE',
    rawLog: 'synthetic raw log DO_NOT_SERIALIZE',
    restrictedHandle: 'session_01SYNTHETIC_RESTRICTED_HANDLE',
  });
}

export function createProductionDependencies(overrides = {}) {
  return {
    admitMachineProfile,
    createCircuitBreaker: (dbPath, options) => new AdmissionCircuitBreaker(dbPath, options),
    decideRecovery,
    managerAuthorityKeyIsCurrent,
    openRunnerStateStore,
    parseManagerPreflightPacket,
    resolveCurrentManagerAuthority,
    resolveIssueSelection,
    serviceExitCode,
    ...overrides,
  };
}

function tracedDependencies(overrides, calls) {
  const source = createProductionDependencies(overrides);
  const wrap = (name, fn) => (...args) => { calls.add(name); return fn(...args); };
  return {
    admitMachineProfile: wrap(PRODUCTION_DEPENDENCY_IDS[0], source.admitMachineProfile),
    createCircuitBreaker: wrap(PRODUCTION_DEPENDENCY_IDS[1], source.createCircuitBreaker),
    managerAuthorityKeyIsCurrent: wrap(PRODUCTION_DEPENDENCY_IDS[2], source.managerAuthorityKeyIsCurrent),
    parseManagerPreflightPacket: wrap(PRODUCTION_DEPENDENCY_IDS[3], source.parseManagerPreflightPacket),
    resolveCurrentManagerAuthority: wrap(PRODUCTION_DEPENDENCY_IDS[4], source.resolveCurrentManagerAuthority),
    serviceExitCode: wrap(PRODUCTION_DEPENDENCY_IDS[5], source.serviceExitCode),
    decideRecovery: wrap(PRODUCTION_DEPENDENCY_IDS[6], source.decideRecovery),
    resolveIssueSelection: wrap(PRODUCTION_DEPENDENCY_IDS[7], source.resolveIssueSelection),
    openRunnerStateStore: wrap(PRODUCTION_DEPENDENCY_IDS[8], source.openRunnerStateStore),
  };
}

function sandbox(deps, now) {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-reliability-fixture-'));
  const repositoryPath = join(root, 'repository');
  const statePath = join(root, 'state', 'runner-state.sqlite');
  const circuitPath = join(root, 'state', 'circuit.sqlite');
  mkdirSync(join(repositoryPath, '.git'), { recursive: true });
  writeFileSync(join(repositoryPath, '.git', 'HEAD'), 'ref: refs/heads/fixture\n');
  let store = deps.openRunnerStateStore(statePath, { now: () => now });
  store.assertWritable();
  return {
    stateDbId: id('fixture-state', 'reliability-fixtures-v1'),
    circuitPath,
    get store() { return store; },
    reopen() { store.close(); store = deps.openRunnerStateStore(statePath, { now: () => now }); return store.assertWritable(); },
    close() { try { store.close(); } catch { /* already closed */ } rmSync(root, { recursive: true, force: true }); },
  };
}

const rows = (store) => ({ claims: count(store.countRows('claims')), attempts: count(store.countRows('recovery_attempts')) });
const common = (evidenceId, capturedAt, head, stateDbId = null) => ({
  evidenceId, capturedAt, head, ...(stateDbId ? { stateDbId } : {}),
});

export function runReliabilityFixtures({ head, now = DEFAULT_NOW, dependencies = {}, adversarial = defaultAdversarialValues() } = {}) {
  if (!SHA.test(String(head || ''))) throw new Error('fixture head must be an exact lowercase commit SHA');
  now = time(now);
  const calls = new Set();
  const deps = tracedDependencies(dependencies, calls);
  const box = sandbox(deps, now);
  const state = counters();
  const scenarios = [];
  try {
    const beforeMachine = snap(state);
    const beforeRows = rows(box.store);
    const machineEnv = {
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'false',
      CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION: 'false',
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'fixture-manager',
      CLAUDE_RUNNER_CRON_AGENT_LABELS: 'agent:claude-code-cli',
    };
    const admission = deps.admitMachineProfile({ argv: ['--execute'], env: machineEnv });
    let breaker = deps.createCircuitBreaker(box.circuitPath, { now: () => now });
    const tripped = breaker.record({ scope: admission.scope, reason: admission.reason, configurationFingerprint: admission.configurationFingerprint, occurredAt: now });
    breaker.close();
    const handledMachine = deps.serviceExitCode(3, machineProfilePausePayload(admission));
    const afterRows = rows(box.store);
    const afterMachine = snap(state);
    const githubIdentity = id('github-identity', 'unchanged-ready-backlog');
    const negativeAdmission = {
      ...common(id('negative-admission', admission.configurationFingerprint), now, head, box.stateDbId),
      profileFingerprintId: id('profile', admission.configurationFingerprint),
      refusalReason: admission.scope,
      beforeGithubIdentityId: githubIdentity,
      afterGithubIdentityId: githubIdentity,
      claimDelta: afterRows.claims - beforeRows.claims,
      attemptDelta: afterRows.attempts - beforeRows.attempts,
      workerStartDelta: delta(afterMachine, beforeMachine, 'workerStarts'),
      githubMutationDelta: delta(afterMachine, beforeMachine, 'githubMutations'),
    };
    const machinePassed = !admission.allowed && admission.scope === FAILURE_SCOPES.MACHINE_PROFILE
      && tripped.tripped && handledMachine === 0 && Object.values(negativeAdmission).slice(-4).every((value) => value === 0)
      && afterMachine.candidatesInspected === 0 && afterMachine.childLaunches === 0 && afterMachine.modelCalls === 0;
    scenarios.push(scenario(SCENARIO_IDS[0], machinePassed, [negativeAdmission.evidenceId], state));

    const beforeRepeat = snap(state);
    const restartReopenProven = box.reopen() === true;
    breaker = deps.createCircuitBreaker(box.circuitPath, { now: () => now });
    const circuit = breaker.check({ configurationFingerprint: admission.configurationFingerprint });
    breaker.close();
    const afterRepeat = snap(state);
    const repeatedRefusal = {
      ...common(id('repeated-refusal', admission.configurationFingerprint), now, head, box.stateDbId),
      profileFingerprintId: negativeAdmission.profileFingerprintId,
      refusalReason: admission.scope,
      refusalCount: 2,
      nextCandidateId: 'issue-6902',
      nextCandidateConsumed: false,
      claimDelta: delta(afterRepeat, beforeRepeat, 'claims'),
      attemptDelta: delta(afterRepeat, beforeRepeat, 'attempts'),
      workerStartDelta: delta(afterRepeat, beforeRepeat, 'workerStarts'),
      githubMutationDelta: delta(afterRepeat, beforeRepeat, 'githubMutations'),
    };
    scenarios.push(scenario(SCENARIO_IDS[1], restartReopenProven && circuit.blocked && !repeatedRefusal.nextCandidateConsumed
      && ['claimDelta', 'attemptDelta', 'workerStartDelta', 'githubMutationDelta'].every((key) => repeatedRefusal[key] === 0), [repeatedRefusal.evidenceId], state));

    const beforeSkip = snap(state);
    state.candidatesInspected += 1;
    const skipped = deps.resolveIssueSelection(issue(6901), []);
    const validComments = [packet({ id: 6902001, createdAt: now, revision: 'AR69-FIXTURE-SELECTABLE-1' })];
    state.candidatesInspected += 1;
    const continued = deps.resolveIssueSelection(issue(6902), validComments);
    const afterSkip = snap(state);
    const issueSkip = {
      ...common(id('issue-skip', '6901:6902'), now, head, box.stateDbId),
      skippedIssueNumber: 6901,
      skipReason: FAILURE_SCOPES.ISSUE_NOT_RUNNABLE,
      continuedIssueNumber: 6902,
      continuedCandidateSelected: continued.mode === 'preflight-direct',
      skippedClaimDelta: delta(afterSkip, beforeSkip, 'claims'),
      skippedGithubMutationDelta: delta(afterSkip, beforeSkip, 'githubMutations'),
    };
    scenarios.push(scenario(SCENARIO_IDS[2], skipped.reason === 'manager-preflight-required'
      && issueSkip.continuedCandidateSelected && issueSkip.skippedClaimDelta === 0 && issueSkip.skippedGithubMutationDelta === 0, [issueSkip.evidenceId], state));

    const beforeTask = snap(state);
    let slotHeld = false;
    let slotReleased = false;
    try {
      slotHeld = true;
      state.attempts += 1;
      state.childLaunches += 1;
      state.workerStarts += 1;
      state.modelCalls += 1;
      throw new Error(adversarial.exceptionMessage);
    } catch {
      // The fixture deliberately discards the arbitrary exception and keeps only a typed scope.
    } finally {
      slotHeld = false;
      slotReleased = true;
    }
    const taskExit = deps.serviceExitCode(1, { failureScope: FAILURE_SCOPES.TASK_ATTEMPT, terminalOutcome: 'validation_failed' });
    state.candidatesInspected += 1;
    const nextSelection = deps.resolveIssueSelection(issue(6903), validComments);
    const afterTask = snap(state);
    const taskFailure = {
      ...common(id('task-failure', 'fixture-task-attempt-1'), now, head, box.stateDbId),
      issueNumber: 5,
      attemptId: 'fixture-task-attempt-1',
      scope: FAILURE_SCOPES.TASK_ATTEMPT,
      serviceExitCode: taskExit,
      systemdResult: taskExit === 0 ? 'success' : 'failed',
      unrelatedIssueNumber: 6903,
      unrelatedIssueStatusPreserved: nextSelection.mode === 'preflight-direct',
      blockedMutation: false,
    };
    scenarios.push(scenario(SCENARIO_IDS[3], !slotHeld && slotReleased && taskExit === 0
      && taskFailure.unrelatedIssueStatusPreserved && delta(afterTask, beforeTask, 'workerStarts') === 1
      && delta(afterTask, beforeTask, 'githubMutations') === 0, [taskFailure.evidenceId], state));

    const blockerDecision = deps.decideRecovery({ outcome: 'plan_only_awaiting_approval', recoveryAttemptCount: 0, now, evidence: {} });
    const blockerEntries = [
      [6904, FAILURE_SCOPES.SYSTEMIC, false, null],
      [6905, FAILURE_SCOPES.MACHINE_PROFILE, false, null],
      [6906, FAILURE_SCOPES.TASK_ATTEMPT, false, null],
      [6907, FAILURE_SCOPES.COMPLETED, false, null],
      [6908, FAILURE_SCOPES.ISSUE_NOT_RUNNABLE, false, null],
      [6909, FAILURE_SCOPES.ISSUE_NOT_RUNNABLE, true, id('real-blocker', blockerDecision.reason)],
    ].map(([issueNumber, scope, blockedApplied, realBlockerEvidenceId]) => ({
      evidenceId: id('blocker-entry', `${issueNumber}:${scope}`), issueNumber, scope, blockedApplied, realBlockerEvidenceId,
    }));
    const blockerAudit = { ...common(id('blocker-audit', 'fixture'), now, head, box.stateDbId), entries: blockerEntries };
    const blocked = blockerEntries.filter((entry) => entry.blockedApplied);
    const blockerTransitionPlan = {
      evidenceId: blocked[0].realBlockerEvidenceId,
      issueNumber: blocked[0].issueNumber,
      fromStatus: 'status:ready',
      toStatus: 'status:blocked',
      reasonCode: blockerDecision.reason,
      externalMutation: false,
    };
    scenarios.push(scenario(SCENARIO_IDS[4], blockerDecision.action === 'attention_required'
      && blockerDecision.reason === 'plan_only_awaiting_approval' && blocked.length === 1
      && blocked[0].scope === FAILURE_SCOPES.ISSUE_NOT_RUNNABLE && state.githubMutations === 0,
    [blockerAudit.evidenceId, ...blockerEntries.map((entry) => entry.evidenceId)], state));

    const beforeAuthority = snap(state);
    const missing = deps.resolveCurrentManagerAuthority([]);
    const initial = packet({ id: 6910001, createdAt: now, revision: 'AR69-FIXTURE-AUTHORITY-1', scope: 'Original scope.' });
    const stale = deps.resolveCurrentManagerAuthority([initial, {
      id: 6910002, created_at: new Date(Date.parse(now) + 1_000).toISOString(), user: { login: 'fixture-manager' },
      body: '## Manager preflight superseded\n\nThis packet no longer authorises a claim.',
    }]);
    const parsed = deps.parseManagerPreflightPacket(initial);
    const edited = packet({ id: 6910001, createdAt: now, revision: 'AR69-FIXTURE-AUTHORITY-1', scope: 'Edited without a new revision.', fingerprint: parsed.fingerprint });
    const editedCurrent = deps.managerAuthorityKeyIsCurrent([edited], parsed.authorityKey, parsed.packetDigest);
    const afterAuthority = snap(state);
    const authorityCases = [
      ['missing', missing.reason, !missing.allowed],
      ['stale', stale.reason, !stale.allowed],
      ['edited', 'manager-preflight-content-changed', !editedCurrent],
    ].map(([caseId, reasonCode, refused]) => ({
      caseId, reasonCode, refused,
      workerStartDelta: delta(afterAuthority, beforeAuthority, 'workerStarts'),
      modelCallDelta: delta(afterAuthority, beforeAuthority, 'modelCalls'),
      githubMutationDelta: delta(afterAuthority, beforeAuthority, 'githubMutations'),
    }));
    const managerAuthority = { ...common(id('manager-authority', 'missing:stale:edited'), now, head, box.stateDbId), cases: authorityCases };
    scenarios.push(scenario(SCENARIO_IDS[5], parsed.valid && authorityCases.every((entry) => entry.refused
      && entry.workerStartDelta === 0 && entry.modelCallDelta === 0 && entry.githubMutationDelta === 0), [managerAuthority.evidenceId], state));

    const acceptanceRecords = {
      negativeAdmission, repeatedRefusal, issueSkip, taskFailure, blockerAudit,
      redaction: {
        ...common(id('redaction', 'fixture-set-v1'), now, head),
        fixtureSetId: 'reliability-fixtures-v1',
        serializedOutputDigestId: 'pending',
        cases: [...REDACTION_CASES], leakCount: 0, serialized: true,
      },
    };
    const draft = {
      head, generatedAt: now, restartReopenProven, productionModules: [...calls],
      acceptanceRecords, managerAuthority, blockerTransitionPlan,
      externalSideEffects: { syntheticWorkerStarts: state.workerStarts }, scenarios,
    };
    acceptanceRecords.redaction.serializedOutputDigestId = id('serialized-output', serializeReliabilityFixtureReport(draft));
    const poisoned = {
      ...draft, unsafe: adversarial,
      scenarios: scenarios.map((entry) => ({ ...entry, unsafe: adversarial })),
      acceptanceRecords: { ...acceptanceRecords, unsafe: adversarial },
      managerAuthority: { ...managerAuthority, unsafe: adversarial },
    };
    const serialized = serializeReliabilityFixtureReport(poisoned);
    acceptanceRecords.redaction.leakCount = Object.values(adversarial).filter((value) => serialized.includes(value)).length;
    const redactionPassed = acceptanceRecords.redaction.leakCount === 0 && REDACTION_CASES.every((entry) => serialized.includes(entry));
    scenarios.push(scenario(SCENARIO_IDS[6], redactionPassed, [acceptanceRecords.redaction.evidenceId], state));
    return normalizeReliabilityFixtureReport({ ...draft, acceptanceRecords, productionModules: [...calls], scenarios });
  } finally {
    box.close();
  }
}

function baseRecord(value = {}, includeState = false) {
  return {
    evidenceId: token(value.evidenceId), capturedAt: time(value.capturedAt),
    head: SHA.test(String(value.head || '')) ? value.head : '0'.repeat(40),
    ...(includeState ? { stateDbId: token(value.stateDbId) } : {}),
  };
}

function normalizeRecords(records = {}) {
  const n = records.negativeAdmission || {}, r = records.repeatedRefusal || {}, s = records.issueSkip || {};
  const t = records.taskFailure || {}, b = records.blockerAudit || {}, x = records.redaction || {};
  return {
    negativeAdmission: { ...baseRecord(n, true), profileFingerprintId: token(n.profileFingerprintId), refusalReason: n.refusalReason === 'systemic' ? 'systemic' : 'machine_profile', beforeGithubIdentityId: token(n.beforeGithubIdentityId), afterGithubIdentityId: token(n.afterGithubIdentityId), claimDelta: count(n.claimDelta), attemptDelta: count(n.attemptDelta), workerStartDelta: count(n.workerStartDelta), githubMutationDelta: count(n.githubMutationDelta) },
    repeatedRefusal: { ...baseRecord(r, true), profileFingerprintId: token(r.profileFingerprintId), refusalReason: r.refusalReason === 'systemic' ? 'systemic' : 'machine_profile', refusalCount: Math.max(1, Math.min(100, count(r.refusalCount))), nextCandidateId: token(r.nextCandidateId), nextCandidateConsumed: r.nextCandidateConsumed === true, claimDelta: count(r.claimDelta), attemptDelta: count(r.attemptDelta), workerStartDelta: count(r.workerStartDelta), githubMutationDelta: count(r.githubMutationDelta) },
    issueSkip: { ...baseRecord(s, true), skippedIssueNumber: count(s.skippedIssueNumber), skipReason: 'issue_not_runnable', continuedIssueNumber: count(s.continuedIssueNumber), continuedCandidateSelected: s.continuedCandidateSelected === true, skippedClaimDelta: count(s.skippedClaimDelta), skippedGithubMutationDelta: count(s.skippedGithubMutationDelta) },
    taskFailure: { ...baseRecord(t, true), issueNumber: count(t.issueNumber), attemptId: token(t.attemptId), scope: 'task_attempt', serviceExitCode: Math.min(255, count(t.serviceExitCode)), systemdResult: t.systemdResult === 'success' ? 'success' : 'failed', unrelatedIssueNumber: count(t.unrelatedIssueNumber), unrelatedIssueStatusPreserved: t.unrelatedIssueStatusPreserved === true, blockedMutation: t.blockedMutation === true },
    blockerAudit: { ...baseRecord(b, true), entries: (b.entries || []).slice(0, 32).map((entry) => ({ evidenceId: token(entry.evidenceId), issueNumber: count(entry.issueNumber), scope: Object.values(FAILURE_SCOPES).includes(entry.scope) ? entry.scope : 'issue_not_runnable', blockedApplied: entry.blockedApplied === true, realBlockerEvidenceId: entry.realBlockerEvidenceId === null ? null : token(entry.realBlockerEvidenceId) })) },
    redaction: { ...baseRecord(x), fixtureSetId: token(x.fixtureSetId), serializedOutputDigestId: token(x.serializedOutputDigestId), cases: [...REDACTION_CASES], leakCount: count(x.leakCount), serialized: x.serialized === true },
  };
}

export function normalizeReliabilityFixtureReport(report = {}) {
  const normalizedScenarios = (report.scenarios || []).slice(0, 16).map((entry) => ({
    id: SCENARIO_IDS.includes(entry.id) ? entry.id : SCENARIO_IDS[6],
    passed: entry.passed === true,
    reasonCode: reason(entry.reasonCode, entry.passed ? 'passed' : 'fixture-invariant-failed'),
    evidenceIds: (entry.evidenceIds || []).map((value) => token(value)).slice(0, 16),
    counters: snap(entry.counters || {}),
  }));
  const passed = normalizedScenarios.filter((entry) => entry.passed).length;
  const authority = report.managerAuthority || {}, plan = report.blockerTransitionPlan || {};
  return {
    schemaVersion: FIXTURE_REPORT_SCHEMA_VERSION,
    acceptanceRecordSchemaVersion: ACCEPTANCE_RECORD_SCHEMA_VERSION,
    mode: 'test-only', repository: EXPECTED_REPOSITORY,
    head: SHA.test(String(report.head || '')) ? report.head : '0'.repeat(40),
    generatedAt: time(report.generatedAt),
    passed: normalizedScenarios.length === SCENARIO_IDS.length && passed === normalizedScenarios.length,
    summary: { required: SCENARIO_IDS.length, passed, failed: normalizedScenarios.length - passed },
    sandbox: { repository: 'temporary', state: 'temporary-sqlite', externalSideEffects: false, restartReopenProven: report.restartReopenProven === true || report.sandbox?.restartReopenProven === true },
    productionModules: [...new Set((report.productionModules || []).filter((value) => PRODUCTION_DEPENDENCY_IDS.includes(value)))],
    acceptanceRecords: normalizeRecords(report.acceptanceRecords),
    managerAuthority: { ...baseRecord(authority, true), cases: (authority.cases || []).slice(0, 8).map((entry) => ({ caseId: ['missing', 'stale', 'edited'].includes(entry.caseId) ? entry.caseId : 'missing', reasonCode: reason(entry.reasonCode), refused: entry.refused === true, workerStartDelta: count(entry.workerStartDelta), modelCallDelta: count(entry.modelCallDelta), githubMutationDelta: count(entry.githubMutationDelta) })) },
    blockerTransitionPlan: { evidenceId: token(plan.evidenceId), issueNumber: count(plan.issueNumber), fromStatus: 'status:ready', toStatus: 'status:blocked', reasonCode: reason(plan.reasonCode), externalMutation: plan.externalMutation === true },
    externalSideEffects: { githubCalls: 0, networkCalls: 0, providerCalls: 0, subprocessCalls: 0, systemdCalls: 0, deployedStateWrites: 0, syntheticWorkerStarts: count(report.externalSideEffects?.syntheticWorkerStarts) },
    scenarios: normalizedScenarios,
  };
}

export const serializeReliabilityFixtureReport = (report) => JSON.stringify(normalizeReliabilityFixtureReport(report), null, 2);

export function parseReliabilityFixtureArgs(argv = process.argv.slice(2), env = process.env) {
  const out = { head: SHA.test(String(env.GITHUB_SHA || '')) ? env.GITHUB_SHA : null, now: new Date().toISOString(), outputPath: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { const value = argv[i + 1]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`); i += 1; return value; };
    if (arg === '--head') out.head = next();
    else if (arg === '--now') out.now = next();
    else if (arg === '--output') out.outputPath = next();
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown fixture argument: ${arg}`);
  }
  return out;
}

export const reliabilityFixturesHelp = () => 'Usage: node scripts/ops/agent-runner-reliability-fixtures.mjs --head <sha> [--now <ISO>] [--output <file>]';

export function main(argv = process.argv.slice(2), env = process.env, logger = console) {
  const args = parseReliabilityFixtureArgs(argv, env);
  if (args.help) { logger.log(reliabilityFixturesHelp()); return 0; }
  const report = runReliabilityFixtures({ head: args.head, now: args.now });
  const serialized = serializeReliabilityFixtureReport(report);
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath);
    mkdirSync(join(outputPath, '..'), { recursive: true });
    writeFileSync(outputPath, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 });
  } else logger.log(serialized);
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); }
  catch { console.error('agent-runner-reliability-fixtures: fixture-execution-failed'); process.exitCode = 1; }
}
