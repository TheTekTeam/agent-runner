import { createHash } from 'node:crypto';

export const QUEUE_TRIAGE_SCHEMA_VERSION = 1;
export const CORE_QUEUE_TRIAGE_LIMITS = Object.freeze({
  fallbackIntervalMinutes: 60,
  rotatingBacklogSlice: 2,
  maxChangedItems: 20,
  maxDebuggerAnomalies: 4,
  maxMutations: 3,
});

export const DEFAULT_QUEUE_TRIAGE_STATUS_LABELS = Object.freeze([
  'status:ready',
  'status:in-progress',
  'status:blocked',
  'status:done',
]);

export const QUEUE_TRIAGE_EXCEPTION_CATEGORIES = Object.freeze([
  'deterministic-metadata-drift',
  'genuine-dependency-blocker',
  'machine-profile-admission-problem',
  'stale-or-invalid-manager-authority',
  'active-implementation-or-recovery',
  'completed-work-awaiting-reconciliation',
  'unresolved-human-product-decision',
  'unsupported-or-incomplete-evidence',
]);

const PROTECTED_EVIDENCE_FLAGS = Object.freeze([
  ['activeClaim', 'active-implementation-or-recovery'],
  ['reservation', 'active-implementation-or-recovery'],
  ['recovery', 'active-implementation-or-recovery'],
  ['newerAuthority', 'stale-or-invalid-manager-authority'],
  ['unresolvedHumanDecision', 'unresolved-human-product-decision'],
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(value, name, { allowEmpty = false, maxItems = 100, maxLength = 255 } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maxItems
    || !value.every((entry) => nonEmptyString(entry) && entry.length <= maxLength)) {
    throw new Error(`${name} must be ${allowEmpty ? 'an' : 'a non-empty'} bounded array of strings`);
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw new Error(`${name} must not contain duplicates`);
  return Object.freeze(unique);
}

function boundedInteger(value, fallback, { name, min, max }) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function evidenceFingerprint(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

export function normalizeQueueTriagePolicy(input = {}, {
  statusLabels = DEFAULT_QUEUE_TRIAGE_STATUS_LABELS,
  priorityLabels = ['priority:P0', 'priority:P1', 'priority:P2', 'priority:P3'],
} = {}) {
  if (!isPlainObject(input)) throw new Error('queueTriage must be an object');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('queueTriage.enabled must be boolean');
  }
  if (input.timezone !== undefined && !nonEmptyString(input.timezone)) {
    throw new Error('queueTriage.timezone must be a non-empty string');
  }

  const acceptedStatusLabels = uniqueStrings(
    input.acceptedStatusLabels ?? statusLabels,
    'queueTriage.acceptedStatusLabels',
  );
  const normalizedPriorityLabels = uniqueStrings(
    input.priorityLabels ?? priorityLabels,
    'queueTriage.priorityLabels',
  );
  const configuredStatuses = new Set(statusLabels);
  const configuredPriorities = new Set(priorityLabels);
  if (acceptedStatusLabels.some((label) => !configuredStatuses.has(label))) {
    throw new Error('queueTriage.acceptedStatusLabels must be a subset of configured status labels');
  }
  if (normalizedPriorityLabels.some((label) => !configuredPriorities.has(label))) {
    throw new Error('queueTriage.priorityLabels must be a subset of configured priority labels');
  }

  return Object.freeze({
    enabled: input.enabled === true,
    fallbackIntervalMinutes: boundedInteger(
      input.fallbackIntervalMinutes,
      CORE_QUEUE_TRIAGE_LIMITS.fallbackIntervalMinutes,
      { name: 'queueTriage.fallbackIntervalMinutes', min: CORE_QUEUE_TRIAGE_LIMITS.fallbackIntervalMinutes, max: 24 * 60 },
    ),
    timezone: input.timezone ?? 'Europe/London',
    rotatingBacklogSlice: boundedInteger(
      input.rotatingBacklogSlice,
      CORE_QUEUE_TRIAGE_LIMITS.rotatingBacklogSlice,
      { name: 'queueTriage.rotatingBacklogSlice', min: 0, max: CORE_QUEUE_TRIAGE_LIMITS.rotatingBacklogSlice },
    ),
    maxChangedItems: boundedInteger(
      input.maxChangedItems,
      CORE_QUEUE_TRIAGE_LIMITS.maxChangedItems,
      { name: 'queueTriage.maxChangedItems', min: 1, max: CORE_QUEUE_TRIAGE_LIMITS.maxChangedItems },
    ),
    maxDebuggerAnomalies: boundedInteger(
      input.maxDebuggerAnomalies,
      CORE_QUEUE_TRIAGE_LIMITS.maxDebuggerAnomalies,
      { name: 'queueTriage.maxDebuggerAnomalies', min: 0, max: CORE_QUEUE_TRIAGE_LIMITS.maxDebuggerAnomalies },
    ),
    maxMutations: boundedInteger(
      input.maxMutations,
      CORE_QUEUE_TRIAGE_LIMITS.maxMutations,
      { name: 'queueTriage.maxMutations', min: 0, max: CORE_QUEUE_TRIAGE_LIMITS.maxMutations },
    ),
    acceptedStatusLabels,
    priorityLabels: normalizedPriorityLabels,
  });
}

function canonicalTimestamp(value, name) {
  if (!nonEmptyString(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function itemIdentity(item) {
  if (!['issue', 'pull_request'].includes(item.kind)) throw new Error('item.kind must be issue or pull_request');
  if (!Number.isInteger(item.number) || item.number < 1) throw new Error('item.number must be a positive integer');
  return `${item.repository}#${item.number}`;
}

function normalizeItem(item, project) {
  if (!isPlainObject(item)) throw new Error('triage item must be an object');
  if (!nonEmptyString(item.repository) || item.repository.toLowerCase() !== project.repository.toLowerCase()) {
    throw new Error('triage item repository must match the project repository');
  }
  const identity = itemIdentity(item);
  const forbiddenKeys = ['body', 'commentBody', 'rawPayload', 'providerOutput', 'prompt', 'secret'];
  if (forbiddenKeys.some((key) => Object.hasOwn(item, key))) {
    throw new Error(`${identity} contains forbidden raw or sensitive evidence fields`);
  }
  const labels = uniqueStrings(item.labels ?? [], `${identity}.labels`, { allowEmpty: true, maxItems: 100 });
  const evidenceRefs = uniqueStrings(item.evidenceRefs ?? [], `${identity}.evidenceRefs`, { allowEmpty: true, maxItems: 20 });
  const flags = isPlainObject(item.flags) ? Object.freeze({ ...item.flags }) : Object.freeze({});
  const dependencies = Array.isArray(item.dependencies)
    ? Object.freeze(item.dependencies.map((dependency, index) => {
      if (!isPlainObject(dependency) || !nonEmptyString(dependency.id) || typeof dependency.complete !== 'boolean') {
        throw new Error(`${identity}.dependencies[${index}] is invalid`);
      }
      return Object.freeze({ id: dependency.id, complete: dependency.complete });
    }))
    : Object.freeze([]);
  const intendedStatus = item.intendedStatus ?? null;
  if (intendedStatus !== null && !project.policy.acceptedStatusLabels.includes(intendedStatus)) {
    throw new Error(`${identity}.intendedStatus is not accepted by project policy`);
  }
  const intendedPriority = item.intendedPriority ?? null;
  if (intendedPriority !== null && !project.policy.priorityLabels.includes(intendedPriority)) {
    throw new Error(`${identity}.intendedPriority is not accepted by project policy`);
  }
  const authoritativeAgentLabel = item.authoritativeAgentLabel ?? null;
  if (authoritativeAgentLabel !== null && !project.acceptedAgentLabels.includes(authoritativeAgentLabel)) {
    throw new Error(`${identity}.authoritativeAgentLabel is not accepted by project policy`);
  }
  let authority = null;
  if (item.authority !== undefined) {
    if (!isPlainObject(item.authority) || !nonEmptyString(item.authority.revision)
      || !nonEmptyString(item.authority.fingerprint) || !item.authority.fingerprint.startsWith('sha256:')) {
      throw new Error(`${identity}.authority must contain a revision and sha256 fingerprint`);
    }
    authority = Object.freeze({ revision: item.authority.revision, fingerprint: item.authority.fingerprint });
  }
  return Object.freeze({
    kind: item.kind,
    number: item.number,
    repository: item.repository,
    updatedAt: canonicalTimestamp(item.updatedAt, `${identity}.updatedAt`),
    labels,
    evidenceRefs,
    flags,
    dependencies,
    intendedStatus,
    intendedPriority,
    authoritativeAgentLabel,
    authority,
    linkedMergedPrComplete: item.linkedMergedPrComplete === true,
    postMergeSettled: item.postMergeSettled === true,
    remainingScope: item.remainingScope === true,
    repositoryPolicyAllowsClose: item.repositoryPolicyAllowsClose === true,
    githubReady: item.githubReady === true,
    runtimeRunnable: item.runtimeRunnable === true ? true : item.runtimeRunnable === false ? false : null,
  });
}

function exceptionFor(item, category, code, evidenceRefs = item.evidenceRefs) {
  return Object.freeze({
    schemaVersion: QUEUE_TRIAGE_SCHEMA_VERSION,
    category,
    code,
    repository: item.repository,
    kind: item.kind,
    number: item.number,
    updatedAt: item.updatedAt,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    fingerprint: evidenceFingerprint({ category, code, repository: item.repository, kind: item.kind, number: item.number, updatedAt: item.updatedAt, evidenceRefs }),
  });
}

function replaceLabelFamily(labels, family, replacement) {
  const withoutFamily = labels.filter((label) => !family.includes(label));
  if (replacement) withoutFamily.push(replacement);
  return Object.freeze([...new Set(withoutFamily)].sort());
}

function buildLabelAction(item, project) {
  let resultingLabels = Object.freeze([...item.labels].sort());
  const currentStatuses = item.labels.filter((label) => project.policy.acceptedStatusLabels.includes(label));
  const currentPriorities = item.labels.filter((label) => project.policy.priorityLabels.includes(label));
  const currentAgents = item.labels.filter((label) => project.acceptedAgentLabels.includes(label));
  const reasons = [];

  if (item.intendedStatus && (currentStatuses.length !== 1 || currentStatuses[0] !== item.intendedStatus)) {
    const dependenciesComplete = item.dependencies.every((dependency) => dependency.complete);
    if (item.intendedStatus === project.statusLabels.ready && !dependenciesComplete) return null;
    if (item.intendedStatus === project.statusLabels.ready && item.flags.explicitHold) return null;
    if (item.intendedStatus === project.statusLabels.blocked && !item.flags.explicitHold && currentStatuses.length === 1) return null;
    resultingLabels = replaceLabelFamily(resultingLabels, project.policy.acceptedStatusLabels, item.intendedStatus);
    reasons.push(currentStatuses.length > 1 ? 'conflicting-status-labels' : 'status-reconciliation');
  }

  if (item.intendedPriority && (currentPriorities.length !== 1 || currentPriorities[0] !== item.intendedPriority)) {
    resultingLabels = replaceLabelFamily(resultingLabels, project.policy.priorityLabels, item.intendedPriority);
    reasons.push(currentPriorities.length > 1 ? 'conflicting-priority-labels' : 'priority-alignment');
  }

  if (item.authoritativeAgentLabel && (currentAgents.length !== 1 || currentAgents[0] !== item.authoritativeAgentLabel)) {
    resultingLabels = replaceLabelFamily(resultingLabels, project.acceptedAgentLabels, item.authoritativeAgentLabel);
    reasons.push(currentAgents.length > 1 ? 'conflicting-agent-labels' : 'agent-alignment');
  }

  if (stableJson(resultingLabels) === stableJson([...item.labels].sort())) return null;
  return { type: 'replace_labels', resultingLabels, reasons: Object.freeze(reasons) };
}

function buildCloseAction(item) {
  if (item.kind !== 'issue' || !item.linkedMergedPrComplete || !item.postMergeSettled || item.remainingScope || !item.repositoryPolicyAllowsClose) return null;
  return { type: 'close_issue', resultingLabels: null, reasons: Object.freeze(['merged-completion-settled']) };
}

function actionPlan(item, action, project, runIdentity) {
  const evidence = {
    repository: item.repository,
    kind: item.kind,
    number: item.number,
    updatedAt: item.updatedAt,
    beforeLabels: [...item.labels].sort(),
    evidenceRefs: item.evidenceRefs,
    reasons: action.reasons,
    intendedAction: action.type,
    resultingLabels: action.resultingLabels,
    runIdentity,
  };
  const fingerprint = evidenceFingerprint(evidence);
  return Object.freeze({
    schemaVersion: QUEUE_TRIAGE_SCHEMA_VERSION,
    projectId: project.projectId,
    repository: item.repository,
    kind: item.kind,
    number: item.number,
    exactBefore: Object.freeze({ labels: Object.freeze([...item.labels].sort()), updatedAt: item.updatedAt }),
    decisiveEvidenceRefs: Object.freeze([...item.evidenceRefs]),
    authority: item.authority,
    action: action.type,
    intendedFullLabelSet: action.resultingLabels,
    risk: 'low-mechanical',
    expectedPostWriteState: action.type === 'close_issue'
      ? Object.freeze({ state: 'closed', stateReason: 'completed' })
      : Object.freeze({ state: 'open', labels: action.resultingLabels }),
    reasons: action.reasons,
    idempotencyKey: `queue-triage:${project.projectId}:${item.kind}:${item.number}:${fingerprint.slice(7, 31)}`,
    evidenceFingerprint: fingerprint,
  });
}

export function planQueueTriageRun(input) {
  if (!isPlainObject(input)) throw new Error('triage input must be an object');
  const projectInput = input.project;
  if (!isPlainObject(projectInput) || !nonEmptyString(projectInput.projectId) || !nonEmptyString(projectInput.repository)) {
    throw new Error('project.projectId and project.repository are required');
  }
  const acceptedAgentLabels = uniqueStrings(projectInput.acceptedAgentLabels ?? [], 'project.acceptedAgentLabels');
  const statusLabelMap = isPlainObject(projectInput.statusLabels)
    ? Object.freeze({ ...projectInput.statusLabels })
    : Object.freeze({
      ready: 'status:ready',
      inProgress: 'status:in-progress',
      blocked: 'status:blocked',
      done: 'status:done',
    });
  if (!nonEmptyString(statusLabelMap.ready) || !nonEmptyString(statusLabelMap.inProgress) || !nonEmptyString(statusLabelMap.blocked)) {
    throw new Error('project.statusLabels must define ready, inProgress and blocked labels');
  }
  const configuredStatusLabels = [...new Set(Object.values(statusLabelMap).filter(nonEmptyString))];
  const policy = normalizeQueueTriagePolicy(projectInput.policy ?? {}, {
    statusLabels: configuredStatusLabels,
    priorityLabels: projectInput.priorityLabels ?? ['priority:P0', 'priority:P1', 'priority:P2', 'priority:P3'],
  });
  const project = Object.freeze({
    projectId: projectInput.projectId,
    repository: projectInput.repository,
    acceptedAgentLabels,
    statusLabels: statusLabelMap,
    policy,
  });
  const observedAt = canonicalTimestamp(input.observedAt, 'observedAt');
  const mode = input.mode ?? 'release';
  if (!['release', 'fallback'].includes(mode)) throw new Error('mode must be release or fallback');
  const releaseId = input.releaseId ?? null;
  if (mode === 'release' && !nonEmptyString(releaseId)) throw new Error('releaseId is required in release mode');

  const changedInput = Array.isArray(input.changedItems) ? input.changedItems : [];
  const rotatingInput = Array.isArray(input.rotatingItems) ? input.rotatingItems : [];
  const changedItems = changedInput.slice(0, policy.maxChangedItems).map((item) => normalizeItem(item, project));
  const rotatingItems = rotatingInput.slice(0, policy.rotatingBacklogSlice).map((item) => normalizeItem(item, project));
  const overflow = Object.freeze({
    changedItems: Math.max(0, changedInput.length - changedItems.length),
    rotatingItems: Math.max(0, rotatingInput.length - rotatingItems.length),
    debuggerAnomalies: 0,
    proposedMutations: 0,
  });
  const runIdentity = evidenceFingerprint({ projectId: project.projectId, repository: project.repository, mode, releaseId, observedAt });
  const plans = [];
  const exceptions = [];
  const inspected = [...changedItems, ...rotatingItems];

  for (const item of inspected) {
    const protectedFlag = PROTECTED_EVIDENCE_FLAGS.find(([flag]) => item.flags[flag] === true);
    if (protectedFlag) {
      exceptions.push(exceptionFor(item, protectedFlag[1], protectedFlag[0]));
      continue;
    }
    if (item.dependencies.some((dependency) => !dependency.complete) && item.intendedStatus === project.statusLabels.ready) {
      exceptions.push(exceptionFor(item, 'genuine-dependency-blocker', 'dependency-incomplete'));
      continue;
    }
    let action = buildCloseAction(item);
    if (!action) action = buildLabelAction(item, project);
    if (action) plans.push(actionPlan(item, action, project, runIdentity));
  }

  const boundedExceptions = exceptions.slice(0, policy.maxDebuggerAnomalies);
  const boundedPlans = plans.slice(0, policy.maxMutations);
  const finalOverflow = Object.freeze({
    ...overflow,
    debuggerAnomalies: Math.max(0, exceptions.length - boundedExceptions.length),
    proposedMutations: Math.max(0, plans.length - boundedPlans.length),
  });
  const inspectedReady = inspected.filter((item) => item.githubReady).length;
  const runtimeConfirmed = inspected.filter((item) => item.runtimeRunnable === true).length;

  return Object.freeze({
    schemaVersion: QUEUE_TRIAGE_SCHEMA_VERSION,
    observedAt,
    dryRun: true,
    mode,
    releaseId,
    project: Object.freeze({ projectId: project.projectId, repository: project.repository }),
    policy,
    inspected: Object.freeze({ changed: changedItems.length, rotating: rotatingItems.length, total: inspected.length }),
    actionPlans: Object.freeze(boundedPlans),
    exceptions: Object.freeze(boundedExceptions),
    counts: Object.freeze({
      inspectedScopeGitHubReady: Object.freeze({ count: inspectedReady, provenance: 'bounded-inspected-items' }),
      repositoryWideReadyLabelled: Object.freeze({ state: 'not_calculated', count: null, provenance: null }),
      runtimeRunnableConfirmed: Object.freeze({
        state: runtimeConfirmed > 0 ? 'partially_proven' : 'not_proven',
        count: runtimeConfirmed,
        provenance: runtimeConfirmed > 0 ? 'normalized-runtime-evidence' : null,
      }),
    }),
    overflow: finalOverflow,
    runControl: Object.freeze({
      schemaVersion: 1,
      status: policy.enabled ? 'dry-run' : 'disabled-dry-run',
      mutationAllowed: false,
      externalReadsPerformed: false,
      controllerDatabaseMutated: false,
      releasesClaimed: 0,
      releasesFinished: 0,
      runIdentity,
    }),
  });
}

export function renderQueueTriageMarkdown(report) {
  const lines = [
    '# Agent Runner queue-triage dry run',
    '',
    `- Project: \`${report.project.projectId}\` (\`${report.project.repository}\`)`,
    `- Mode: \`${report.mode}\``,
    `- Release: ${report.releaseId ? `\`${report.releaseId}\`` : '`none`'}`,
    `- Inspected: ${report.inspected.total} (${report.inspected.changed} changed, ${report.inspected.rotating} rotating)`,
    `- Proposed mutations: ${report.actionPlans.length}`,
    `- Exceptions: ${report.exceptions.length}`,
    '',
    '## Proposed actions',
    '',
  ];
  if (report.actionPlans.length === 0) lines.push('- None.');
  for (const plan of report.actionPlans) {
    lines.push(`- ${plan.repository}#${plan.number}: \`${plan.action}\` — ${plan.reasons.join(', ')}`);
  }
  lines.push('', '## Exceptions', '');
  if (report.exceptions.length === 0) lines.push('- None.');
  for (const exception of report.exceptions) {
    lines.push(`- ${exception.repository}#${exception.number}: \`${exception.category}\` / \`${exception.code}\``);
  }
  lines.push(
    '',
    '## Count provenance',
    '',
    `- Inspected-scope GitHub-ready: ${report.counts.inspectedScopeGitHubReady.count}`,
    '- Repository-wide ready-labelled: not calculated',
    `- Runtime-runnable confirmed: ${report.counts.runtimeRunnableConfirmed.state}`,
    '',
    '## Overflow',
    '',
    `- Changed items: ${report.overflow.changedItems}`,
    `- Rotating items: ${report.overflow.rotatingItems}`,
    `- Debugger anomalies: ${report.overflow.debuggerAnomalies}`,
    `- Proposed mutations: ${report.overflow.proposedMutations}`,
    '',
    '## RUN_CONTROL',
    '',
    '```json',
    JSON.stringify(report.runControl),
    '```',
  );
  return `${lines.join('\n')}\n`;
}

export function generateOpenAIOversightPrompt() {
  const limits = CORE_QUEUE_TRIAGE_LIMITS;
  return [
    'Use GitHub only as an oversight and exception-review agent for Agent Runner queue triage.',
    'Do not duplicate deterministic mutations performed by Agent Runner.',
    `Inspect at most ${limits.maxChangedItems} changed items, exactly ${limits.rotatingBacklogSlice} rotating unchanged issues, and reconstruct at most ${limits.maxDebuggerAnomalies} anomalies.`,
    `Never authorise more than ${limits.maxMutations} low-risk mutation proposals per project run.`,
    'Treat consumed, superseded or revoked manager packets as non-authority.',
    'Preserve active claims, reservations, recovery and explicit human holds.',
    'Keep inspected-scope readiness, repository-wide ready-labelled counts and runtime-runnable proof separate.',
    'Use only existing plans, local/self-hosted tooling and free or already-paid services.',
    'Report material disagreement with the Agent Runner dry-run result and fail closed.',
  ].join('\n');
}
