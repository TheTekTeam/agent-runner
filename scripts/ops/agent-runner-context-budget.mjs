import { createHash } from 'node:crypto';

export const CONTEXT_BUDGET_SCHEMA_VERSION = 1;
export const CONTEXT_BUDGET_POLICY_REVISION = 'context-budget-v1';

export const SESSION_DECISIONS = Object.freeze([
  'fresh-task',
  'same-attempt-continuation',
  'same-pr-correction',
  'context-stale',
  'provider-context-incompatible',
]);

export const TASK_BUDGETS = Object.freeze({
  routine: Object.freeze({ maxContextBytes: 24 * 1024, maxTurns: 6, reasoningEffort: 'low', maxOutputBytes: 4 * 1024 }),
  narrow: Object.freeze({ maxContextBytes: 32 * 1024, maxTurns: 10, reasoningEffort: 'low', maxOutputBytes: 6 * 1024 }),
  normal: Object.freeze({ maxContextBytes: 48 * 1024, maxTurns: 18, reasoningEffort: 'medium', maxOutputBytes: 8 * 1024 }),
  complex: Object.freeze({ maxContextBytes: 72 * 1024, maxTurns: 30, reasoningEffort: 'high', maxOutputBytes: 12 * 1024 }),
  critical: Object.freeze({ maxContextBytes: 96 * 1024, maxTurns: 42, reasoningEffort: 'high', maxOutputBytes: 16 * 1024 }),
});

const PRIORITY = Object.freeze({
  authority: 0,
  instructions: 1,
  task: 2,
  source: 3,
  deterministicEvidence: 4,
  validation: 5,
  reviewDelta: 6,
  checkpoint: 7,
  hints: 8,
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  const source = typeof value === 'string' ? value : JSON.stringify(stable(value));
  return createHash('sha256').update(source).digest('hex');
}

function boundedString(value, maxChars = 2000) {
  return String(value ?? '').replace(/\r/g, '').slice(0, maxChars);
}

function identity(value = {}) {
  return {
    projectId: value.projectId || null,
    githubRepo: value.githubRepo || null,
    issueNumber: Number.isInteger(value.issueNumber) ? value.issueNumber : null,
    prNumber: Number.isInteger(value.prNumber) ? value.prNumber : null,
    branch: value.branch || null,
    sourceFingerprint: value.sourceFingerprint || null,
    authorityRevision: value.authorityRevision || null,
  };
}

function sameTenantTask(a, b) {
  return Boolean(
    a?.projectId && b?.projectId && a.projectId === b.projectId
    && a?.githubRepo && b?.githubRepo && a.githubRepo.toLowerCase() === b.githubRepo.toLowerCase()
    && a?.issueNumber && b?.issueNumber && a.issueNumber === b.issueNumber
  );
}

export function decideSessionLifecycle({
  taskIdentity,
  session = null,
  recovery = null,
  provider = {},
  context = {},
} = {}) {
  const task = identity(taskIdentity);
  if (!session) return Object.freeze({ decision: 'fresh-task', resume: false, compact: false, reason: 'no-bound-session' });
  const bound = identity(session.identity);
  if (!sameTenantTask(task, bound)) {
    return Object.freeze({ decision: 'fresh-task', resume: false, compact: false, reason: 'different-project-repository-or-issue' });
  }

  const providerCompatible = [
    ['adapterRevision', session.adapterRevision, provider.adapterRevision],
    ['model', session.model, provider.model],
    ['toolPolicyFingerprint', session.toolPolicyFingerprint, provider.toolPolicyFingerprint],
    ['systemFingerprint', session.systemFingerprint, provider.systemFingerprint],
  ].every(([, oldValue, newValue]) => !oldValue || !newValue || oldValue === newValue);
  if (!providerCompatible) {
    return Object.freeze({ decision: 'provider-context-incompatible', resume: false, compact: false, reason: 'provider-or-tool-context-changed' });
  }

  if (recovery?.requiresExactSession === true) {
    if (!recovery.sessionId || recovery.sessionId !== session.sessionId) {
      return Object.freeze({ decision: 'provider-context-incompatible', resume: false, compact: false, reason: 'required-recovery-session-mismatch' });
    }
    return Object.freeze({ decision: 'same-attempt-continuation', resume: true, compact: false, reason: 'exact-recovery-session-required' });
  }

  const utilisation = Math.max(0, Math.min(1, Number(context.utilisation || 0)));
  const priorCycles = Math.max(0, Number(context.correctionCycles || 0));
  const stale = context.phaseBoundary === true
    || utilisation >= 0.72
    || Number(context.accumulatedToolBytes || 0) >= 96 * 1024
    || priorCycles >= 3;
  if (stale) {
    const compactSupported = provider.compactionSupported === true;
    return Object.freeze({
      decision: 'context-stale',
      resume: compactSupported,
      compact: compactSupported,
      reason: compactSupported ? 'relevant-session-but-context-overhead-high' : 'fresh-context-cheaper-than-stale-replay',
    });
  }

  if (task.prNumber && bound.prNumber === task.prNumber && session.relevance === 'high') {
    return Object.freeze({ decision: 'same-pr-correction', resume: true, compact: false, reason: 'same-pr-high-relevance-session' });
  }
  return Object.freeze({ decision: 'fresh-task', resume: false, compact: false, reason: 'session-not-materially-useful' });
}

export function chooseContextBudget({ taskClass = 'normal', risk = 'normal', adapterCapabilities = {}, requestedReasoningEffort = null } = {}) {
  const base = TASK_BUDGETS[taskClass] || TASK_BUDGETS.normal;
  let reasoningEffort = base.reasoningEffort;
  if (risk === 'critical' || risk === 'security' || risk === 'architecture') reasoningEffort = 'high';
  const rank = { low: 0, medium: 1, high: 2 };
  if (requestedReasoningEffort && rank[requestedReasoningEffort] > rank[reasoningEffort]) reasoningEffort = requestedReasoningEffort;
  const providerControls = {
    maxTurns: adapterCapabilities.maxTurns === true ? base.maxTurns : null,
    reasoningEffort: adapterCapabilities.reasoningEffort === true ? reasoningEffort : null,
    outputBudgetBytes: adapterCapabilities.outputBudget === true ? base.maxOutputBytes : null,
  };
  return Object.freeze({
    schemaVersion: CONTEXT_BUDGET_SCHEMA_VERSION,
    taskClass: TASK_BUDGETS[taskClass] ? taskClass : 'normal',
    risk,
    maxContextBytes: base.maxContextBytes,
    maxOutputBytes: base.maxOutputBytes,
    maxTurns: base.maxTurns,
    reasoningEffort,
    providerControls,
    unsupportedControls: Object.entries(providerControls).filter(([, value]) => value === null).map(([key]) => key),
  });
}

function normaliseSection(section, index) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error(`context section ${index} is invalid`);
  const kind = section.kind;
  if (!(kind in PRIORITY)) throw new Error(`unknown context section kind: ${String(kind)}`);
  const required = section.required === true || ['authority', 'task', 'source'].includes(kind);
  const value = typeof section.value === 'string' ? section.value : JSON.stringify(stable(section.value ?? null));
  const maxBytes = Math.max(128, Math.min(Number(section.maxBytes || 16 * 1024), 64 * 1024));
  return { kind, required, value, maxBytes, identity: section.identity || null, index };
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text, truncated: false, originalBytes: buffer.byteLength };
  let sliced = buffer.subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(sliced, 'utf8') > maxBytes) sliced = sliced.slice(0, -1);
  return { text: sliced, truncated: true, originalBytes: buffer.byteLength };
}

export function buildBoundedContextCapsule({ sections = [], budget, priorAcceptedEvidence = [] } = {}) {
  if (!budget?.maxContextBytes) throw new Error('context budget is required');
  const prior = new Set(priorAcceptedEvidence.filter((value) => typeof value === 'string'));
  const normalized = sections.map(normaliseSection).sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.index - b.index);
  const output = [];
  let bytes = 0;
  let truncated = false;

  for (const section of normalized) {
    const sectionDigest = `sha256:${digest(section.value)}`;
    if (!section.required && prior.has(sectionDigest)) {
      output.push({ kind: section.kind, unchangedEvidenceRef: sectionDigest, omittedAsUnchanged: true });
      continue;
    }
    const localLimit = Math.min(section.maxBytes, Math.max(0, budget.maxContextBytes - bytes));
    if (localLimit < 64) {
      if (section.required) throw new Error(`required context section '${section.kind}' cannot fit hard budget`);
      truncated = true;
      continue;
    }
    const bounded = truncateUtf8(section.value, localLimit);
    if (bounded.truncated && section.required) {
      throw new Error(`required context section '${section.kind}' exceeds its safe budget`);
    }
    output.push({
      kind: section.kind,
      value: bounded.text,
      digest: sectionDigest,
      truncated: bounded.truncated,
      originalBytes: bounded.originalBytes,
    });
    bytes += Buffer.byteLength(bounded.text, 'utf8');
    truncated ||= bounded.truncated;
  }

  const capsule = {
    schemaVersion: CONTEXT_BUDGET_SCHEMA_VERSION,
    policyRevision: CONTEXT_BUDGET_POLICY_REVISION,
    budget: { maxContextBytes: budget.maxContextBytes },
    sections: output,
    bytes,
    truncated,
  };
  capsule.fingerprint = `sha256:${digest(capsule)}`;
  return Object.freeze(capsule);
}

export function normalizeModelVisibleResult({ kind, status, target = null, output = '', level = 'default' } = {}) {
  const limits = { default: 1600, expanded: 6000, maximum: 16000 };
  if (!(level in limits)) throw new Error('unsupported diagnostic level');
  const text = boundedString(output, 100_000);
  const bounded = truncateUtf8(text, limits[level]);
  return Object.freeze({
    kind: kind || 'operation',
    status: status || 'unknown',
    target,
    diagnostic: bounded.text || null,
    diagnosticDigest: `sha256:${digest(text)}`,
    truncated: bounded.truncated,
    escalationAvailable: level !== 'maximum' && bounded.truncated,
    level,
  });
}

export function buildAcceptedStateCapsule({ taskIdentity, completed = [], validation = [], unresolvedReview = [], checkpoint = null, nextGoal = null } = {}) {
  const capsule = {
    schemaVersion: CONTEXT_BUDGET_SCHEMA_VERSION,
    identity: identity(taskIdentity),
    completed: completed.slice(0, 24).map((value) => boundedString(value, 400)),
    validation: validation.slice(0, 24).map((value) => stable(value)),
    unresolvedReview: unresolvedReview.slice(0, 16).map((value) => stable(value)),
    checkpoint: checkpoint ? stable(checkpoint) : null,
    nextGoal: nextGoal ? boundedString(nextGoal, 800) : null,
  };
  capsule.fingerprint = `sha256:${digest(capsule)}`;
  return Object.freeze(capsule);
}

export function buildContinuationDelta({ previous = {}, current = {} } = {}) {
  const delta = {};
  const fields = ['sourceFingerprint', 'headSha', 'authorityRevision', 'checkpointFingerprint'];
  for (const field of fields) if (current[field] !== undefined && current[field] !== previous[field]) delta[field] = current[field];
  const previousReviews = new Map((previous.reviewFindings || []).map((item) => [item.id, digest(item)]));
  delta.reviewFindings = (current.reviewFindings || []).filter((item) => previousReviews.get(item.id) !== digest(item));
  const previousValidation = new Map((previous.validation || []).map((item) => [item.id || item.target, digest(item)]));
  delta.validation = (current.validation || []).filter((item) => previousValidation.get(item.id || item.target) !== digest(item));
  delta.changed = Object.keys(delta).some((key) => Array.isArray(delta[key]) ? delta[key].length > 0 : true);
  delta.fingerprint = `sha256:${digest(delta)}`;
  return Object.freeze(delta);
}

export function shouldStopProvider({ implementationComplete = false, deterministicAcceptanceGreen = false, unresolvedReasoningBlocker = false, turnCeilingReached = false } = {}) {
  if (turnCeilingReached) return Object.freeze({ stop: true, preserveCheckpoint: true, reason: 'turn-ceiling-reached' });
  if (implementationComplete && deterministicAcceptanceGreen && !unresolvedReasoningBlocker) {
    return Object.freeze({ stop: true, preserveCheckpoint: false, reason: 'accepted-provider-phase-complete' });
  }
  return Object.freeze({ stop: false, preserveCheckpoint: false, reason: unresolvedReasoningBlocker ? 'reasoning-correction-required' : 'work-remains' });
}

export function contextBudgetTelemetry({ lifecycle, budget, capsule, usage = {}, deterministic = {} } = {}) {
  return Object.freeze({
    schemaVersion: CONTEXT_BUDGET_SCHEMA_VERSION,
    lifecycleDecision: lifecycle?.decision || null,
    lifecycleReason: lifecycle?.reason || null,
    compact: lifecycle?.compact === true,
    taskClass: budget?.taskClass || null,
    reasoningEffort: budget?.reasoningEffort || null,
    maxTurns: budget?.maxTurns || null,
    contextBytesAtLaunch: capsule?.bytes ?? null,
    contextFingerprint: capsule?.fingerprint || null,
    inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
    outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
    cacheReadTokens: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
    reasoningTokens: Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : null,
    turnCount: Number.isFinite(usage.turnCount) ? usage.turnCount : null,
    deterministicEvidenceReused: Number.isFinite(deterministic.evidenceReused) ? deterministic.evidenceReused : null,
    providerInvocationAvoided: deterministic.providerInvocationAvoided === true,
  });
}
