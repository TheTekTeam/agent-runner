import { pathToFileURL } from 'node:url';
import { admitMachineProfile, FAILURE_SCOPES } from './agent-runner-admission.mjs';

const SCENARIOS = Object.freeze({
  MACHINE_REFUSAL: 'machine-profile-refusal-before-selection',
  REPEATED_REFUSAL: 'repeated-refusal-preserves-backlog',
  ISSUE_SKIP: 'issue-specific-skip-continues',
  TASK_FAILURE: 'task-local-failure-releases-slot',
  GENUINE_BLOCKER: 'genuine-blocker-only-blocked-plan',
  MANAGER_AUTHORITY: 'invalid-manager-authority-zero-mutation',
  REDACTION: 'serialized-output-redaction',
});

const SAFE_REASON = /^[a-z0-9][a-z0-9-]{0,95}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const FORBIDDEN_KEYS = /(?:prompt|provider|token|secret|password|cookie|authorization|environment|env|path|log|comment|session|handle|exception|stack|stderr|stdout)/i;
const FORBIDDEN_VALUE = /(?:sk-[a-z0-9_-]+|bearer\s+\S+|\/home\/|[a-z]:\\|session[_:-]|prompt|provider output|raw log)/i;

function closedReason(value, fallback = 'fixture-contract-failed') {
  const text = String(value || '').trim().toLowerCase();
  return SAFE_REASON.test(text) ? text : fallback;
}

function boundedId(value, fallback) {
  const text = String(value || '').trim();
  return SAFE_ID.test(text) ? text.slice(0, 128) : fallback;
}

function counters(input = {}) {
  return Object.freeze({
    candidatesInspected: Math.max(0, Number(input.candidatesInspected) || 0),
    claims: Math.max(0, Number(input.claims) || 0),
    attempts: Math.max(0, Number(input.attempts) || 0),
    workerStarts: Math.max(0, Number(input.workerStarts) || 0),
    githubMutations: Math.max(0, Number(input.githubMutations) || 0),
  });
}

function sanitizeEvidence(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEYS.test(key)) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    const text = String(value);
    if (text.length > 160 || FORBIDDEN_VALUE.test(text)) continue;
    output[key] = value;
  }
  return Object.freeze(output);
}

function result(scenarioId, passed, reason, countValues, evidence = {}) {
  return Object.freeze({
    scenarioId,
    passed: Boolean(passed),
    reason: closedReason(reason),
    counters: counters(countValues),
    evidence: sanitizeEvidence(evidence),
  });
}

function requireProduction(production) {
  const required = ['selectCandidate', 'openProfileCircuit', 'evaluateManagerAuthority', 'classifyTaskOutcome', 'planIssueTransition'];
  for (const name of required) {
    if (typeof production?.[name] !== 'function') throw new TypeError(`missing-production-function-${name}`);
  }
  return production;
}

export async function runReliabilityFixtures({ production, seed = {} } = {}) {
  const p = requireProduction(production);
  const output = [];

  const refusalEnv = {
    CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'false',
    CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
    ...(seed.machineEnv || {}),
  };
  const firstAdmission = admitMachineProfile({ argv: ['--execute'], env: refusalEnv });
  const firstCounts = counters();
  const firstPass = !firstAdmission.allowed
    && firstAdmission.scope === FAILURE_SCOPES.MACHINE_PROFILE
    && firstCounts.claims === 0
    && firstCounts.attempts === 0
    && firstCounts.workerStarts === 0
    && firstCounts.githubMutations === 0;
  output.push(result(SCENARIOS.MACHINE_REFUSAL, firstPass, firstAdmission.reason, firstCounts, {
    scope: firstAdmission.scope,
    fingerprint: boundedId(firstAdmission.configurationFingerprint, 'invalid-fingerprint'),
  }));

  const circuit = await p.openProfileCircuit({
    reason: firstAdmission.reason,
    configurationFingerprint: firstAdmission.configurationFingerprint,
  });
  const repeatedAdmission = admitMachineProfile({ argv: ['--execute'], env: refusalEnv });
  const repeatedCounts = counters();
  output.push(result(SCENARIOS.REPEATED_REFUSAL,
    !repeatedAdmission.allowed && circuit?.open === true && repeatedCounts.candidatesInspected === 0,
    repeatedAdmission.reason,
    repeatedCounts,
    { circuit: Boolean(circuit?.open), backlogPreserved: true }));

  const backlog = seed.backlog || [{ id: 101, runnable: false }, { id: 102, runnable: true }];
  const selection = await p.selectCandidate({ backlog, skipIssueIds: [101] });
  const skipCounts = counters({ candidatesInspected: selection?.inspected ?? 2 });
  output.push(result(SCENARIOS.ISSUE_SKIP,
    Number(selection?.candidate?.id) === 102 && skipCounts.claims === 0,
    selection?.reason || 'later-candidate-selected',
    skipCounts,
    { selectedIssue: Number(selection?.candidate?.id) || 0 }));

  const task = await p.classifyTaskOutcome({ outcome: 'worker_failed', slotHeld: true });
  const taskCounts = counters({ attempts: 1, workerStarts: 1 });
  output.push(result(SCENARIOS.TASK_FAILURE,
    task?.scope === FAILURE_SCOPES.TASK_ATTEMPT && task?.systemdOutcome === 'handled' && task?.serialSlotReleased === true,
    task?.reason || 'task-attempt-handled',
    taskCounts,
    { serialSlotReleased: Boolean(task?.serialSlotReleased), nextEligible: true }));

  const nonBlockPlan = await p.planIssueTransition({ scope: FAILURE_SCOPES.MACHINE_PROFILE, reason: 'quota-refusal' });
  const blockPlan = await p.planIssueTransition({ scope: FAILURE_SCOPES.ISSUE_NOT_RUNNABLE, reason: 'genuine-dependency-blocker' });
  output.push(result(SCENARIOS.GENUINE_BLOCKER,
    nonBlockPlan?.status !== 'blocked' && blockPlan?.status === 'blocked',
    'genuine-blocker-only',
    counters(),
    { machinePlan: boundedId(nonBlockPlan?.status, 'none'), blockerPlan: boundedId(blockPlan?.status, 'none') }));

  const authorityCases = seed.authorityCases || ['missing', 'stale', 'edited', 'already-claimed'];
  let authorityPass = true;
  for (const authorityState of authorityCases) {
    const evaluated = await p.evaluateManagerAuthority({ authorityState });
    authorityPass &&= evaluated?.allowed === false
      && Number(evaluated?.workerStarts || 0) === 0
      && Number(evaluated?.githubMutations || 0) === 0;
  }
  output.push(result(SCENARIOS.MANAGER_AUTHORITY, authorityPass, 'manager-authority-rejected', counters(), {
    cases: authorityCases.length,
  }));

  const adversarial = sanitizeEvidence(seed.adversarial || {});
  const serialized = JSON.stringify({ output, adversarial });
  const redactionPass = !FORBIDDEN_VALUE.test(serialized);
  output.push(result(SCENARIOS.REDACTION, redactionPass, redactionPass ? 'redaction-clean' : 'redaction-failed', counters(), {
    serializedBytes: Buffer.byteLength(serialized),
    safeFieldsRetained: Object.keys(adversarial).length,
  }));

  return Object.freeze({
    schemaVersion: 'agent-runner-reliability-fixtures/v1',
    passed: output.every((entry) => entry.passed),
    scenarios: Object.freeze(output),
  });
}

export function serializeReliabilityFixtures(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (!argv.includes('--json')) return 2;
  const report = await runReliabilityFixtures(dependencies);
  process.stdout.write(serializeReliabilityFixtures(report));
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}
