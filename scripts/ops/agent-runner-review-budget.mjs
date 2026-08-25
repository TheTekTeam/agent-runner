import { createHash } from 'node:crypto';

export const REVIEW_BUDGET_SCHEMA_VERSION = 1;
export const REVIEW_BUDGET_REVISION = 'review-budget-shadow-v1';
export const REVIEW_RISK_CLASSES = Object.freeze(['deterministic-only', 'low-risk', 'normal', 'high-risk', 'critical']);

const RANK = Object.freeze(Object.fromEntries(REVIEW_RISK_CLASSES.map((value, index) => [value, index])));
const HIGH_RISK_PATH = /(^|\/)(auth|security|permissions?|secrets?|billing|payments?|migrations?|deploy|deployment|scheduler|controller|manager|provider|quota|admission|credentials?|sessions?|csrf|cors|crypto|database|db)(\/|\.|-|$)/i;
const CRITICAL_PATH = /(^|\/)(source-activation|production|release|credential-store|authority-ledger)(\/|\.|-|$)/i;
const LOW_RISK_PATH = /(^|\/)(docs?|fixtures?|examples?)(\/|$)|\.(md|txt)$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/;
const SHA = /^[a-f0-9]{40,64}$/i;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function boundedText(value, maxBytes) {
  const source = String(value ?? '').replace(/\r/g, '');
  const buffer = Buffer.from(source, 'utf8');
  if (buffer.byteLength <= maxBytes) return { value: source, truncated: false, originalBytes: buffer.byteLength };
  let output = buffer.subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(output, 'utf8') > maxBytes) output = output.slice(0, -1);
  return { value: output, truncated: true, originalBytes: buffer.byteLength };
}

function normalizePaths(values = []) {
  if (!Array.isArray(values) || values.length > 256) throw new Error('changedFiles is invalid');
  return [...new Set(values.map((value) => {
    if (typeof value !== 'string' || !value || value.length > 512 || value.startsWith('/') || value.includes('..')) throw new Error('changed file path is invalid');
    return value.replaceAll('\\', '/');
  }))].sort();
}

function normalizeRisk(value) {
  return REVIEW_RISK_CLASSES.includes(value) ? value : null;
}

function maxRisk(...values) {
  return values.filter(Boolean).sort((a, b) => RANK[b] - RANK[a])[0] || 'high-risk';
}

export function classifyReviewRisk({ changedFiles = [], structuredRisk = null, deterministicOnlyQualified = false } = {}) {
  const files = normalizePaths(changedFiles);
  const declared = normalizeRisk(structuredRisk);
  let inferred = null;
  const reasons = [];

  if (files.some((file) => CRITICAL_PATH.test(file))) {
    inferred = 'critical';
    reasons.push('critical-control-surface');
  } else if (files.some((file) => HIGH_RISK_PATH.test(file))) {
    inferred = 'high-risk';
    reasons.push('high-risk-control-surface');
  } else if (files.length > 0 && files.every((file) => LOW_RISK_PATH.test(file))) {
    inferred = 'low-risk';
    reasons.push('bounded-docs-fixture-scope');
  } else if (files.length > 0) {
    inferred = 'normal';
    reasons.push('ordinary-source-scope');
  }

  // Missing structured risk is never used to claim a cheap/no-model class.
  // It conservatively raises otherwise-low/unknown work to normal; completely
  // unknown scope is high-risk so absence cannot downgrade review.
  let risk = inferred || 'high-risk';
  if (!declared && risk === 'low-risk') {
    risk = 'normal';
    reasons.push('structured-risk-missing');
  }
  if (!declared && files.length === 0) reasons.push('scope-unknown');
  if (declared) {
    risk = maxRisk(risk, declared);
    reasons.push(`structured-risk:${declared}`);
  }
  if (risk === 'deterministic-only' && !deterministicOnlyQualified) {
    risk = 'normal';
    reasons.push('deterministic-only-not-qualified');
  }

  const payload = { schemaVersion: REVIEW_BUDGET_SCHEMA_VERSION, risk, changedFiles: files, reasons: [...new Set(reasons)].sort() };
  return Object.freeze({ ...payload, fingerprint: digest(payload) });
}

export function planShadowReview({
  classification,
  deterministicValidation = { terminal: false, green: false },
  localReviewer = null,
  deterministicOnlyQualified = false,
} = {}) {
  if (!classification || !REVIEW_RISK_CLASSES.includes(classification.risk)) throw new Error('review classification is required');
  if (deterministicValidation.terminal === true && deterministicValidation.green !== true) {
    return Object.freeze({ invokeReviewer: false, route: null, reason: 'deterministic-acceptance-failed', correctionFirst: true, shadowOnly: true });
  }
  if (deterministicValidation.terminal !== true) {
    return Object.freeze({ invokeReviewer: false, route: null, reason: 'deterministic-acceptance-not-terminal', correctionFirst: false, shadowOnly: true });
  }

  const risk = classification.risk;
  if (risk === 'deterministic-only') {
    return Object.freeze({
      invokeReviewer: deterministicOnlyQualified !== true,
      route: deterministicOnlyQualified ? null : 'strong-independent-provider',
      reason: deterministicOnlyQualified ? 'qualified-deterministic-only-shadow' : 'deterministic-only-not-qualified',
      correctionFirst: false,
      shadowOnly: true,
    });
  }
  if (risk === 'low-risk' && localReviewer?.reviewQualified === true && localReviewer?.ready === true && localReviewer?.paid !== true) {
    return Object.freeze({ invokeReviewer: true, route: 'qualified-local-reviewer', reason: 'low-risk-qualified-local-shadow', correctionFirst: false, shadowOnly: true });
  }
  return Object.freeze({
    invokeReviewer: true,
    route: risk === 'high-risk' || risk === 'critical' ? 'strong-independent-provider' : 'independent-provider',
    reason: risk === 'high-risk' || risk === 'critical' ? 'strong-review-required' : 'independent-review-required',
    correctionFirst: false,
    shadowOnly: true,
  });
}

export function buildDiffFirstReviewCapsule({
  repository,
  issueNumber,
  baseSha,
  headSha,
  classification,
  changedFiles = [],
  diff = '',
  deterministicValidation = [],
  authorityFingerprint = null,
  maxDiffBytes = 32 * 1024,
} = {}) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('repository is invalid');
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('issueNumber is invalid');
  if (!SHA.test(baseSha || '') || !SHA.test(headSha || '')) throw new Error('review source identity is invalid');
  if (!classification || !REVIEW_RISK_CLASSES.includes(classification.risk)) throw new Error('review classification is required');
  if (authorityFingerprint !== null && !/^sha256:[a-f0-9]{64}$/.test(authorityFingerprint)) throw new Error('authorityFingerprint is invalid');
  if (!Array.isArray(deterministicValidation) || deterministicValidation.length > 64) throw new Error('deterministicValidation is invalid');
  const files = normalizePaths(changedFiles);
  const bounded = boundedText(diff, Math.max(1024, Math.min(Number(maxDiffBytes) || 0, 64 * 1024)));
  const payload = {
    schemaVersion: REVIEW_BUDGET_SCHEMA_VERSION,
    revision: REVIEW_BUDGET_REVISION,
    repository,
    issueNumber,
    baseSha: baseSha.toLowerCase(),
    headSha: headSha.toLowerCase(),
    authorityFingerprint,
    risk: classification.risk,
    classificationFingerprint: classification.fingerprint,
    changedFiles: files,
    diff: bounded.value,
    diffTruncated: bounded.truncated,
    diffOriginalBytes: bounded.originalBytes,
    deterministicValidation: deterministicValidation.map((item) => stable(item)),
    contextPolicy: 'diff-first-bounded',
  };
  return Object.freeze({ ...payload, capsuleFingerprint: digest(payload) });
}

export function coalesceExactHeadReviewSignals({ headSha, requiredSources = [], signals = [] } = {}) {
  if (!SHA.test(headSha || '')) throw new Error('headSha is invalid');
  if (!Array.isArray(requiredSources) || requiredSources.length > 16) throw new Error('requiredSources is invalid');
  if (!Array.isArray(signals) || signals.length > 128) throw new Error('signals is invalid');
  const required = [...new Set(requiredSources.map((value) => {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('required review source is invalid');
    return value;
  }))].sort();
  const current = signals.filter((signal) => signal?.headSha === headSha).map((signal) => ({
    source: signal.source,
    terminal: signal.terminal === true,
    severity: ['critical', 'high', 'normal', 'low'].includes(signal.severity) ? signal.severity : 'normal',
    findingIds: Array.isArray(signal.findingIds) ? signal.findingIds.slice(0, 64).filter((value) => typeof value === 'string' && TOKEN.test(value)).sort() : [],
  }));
  const sourceState = new Map(current.map((signal) => [signal.source, signal]));
  const pendingRequired = required.filter((source) => sourceState.get(source)?.terminal !== true);
  const critical = current.some((signal) => signal.severity === 'critical' && signal.findingIds.length > 0);
  const actionableFindingIds = [...new Set(current.flatMap((signal) => signal.findingIds))].sort();
  const readyForCorrection = critical || (pendingRequired.length === 0 && actionableFindingIds.length > 0);
  const payload = {
    schemaVersion: REVIEW_BUDGET_SCHEMA_VERSION,
    headSha: headSha.toLowerCase(),
    pendingRequired,
    criticalWake: critical,
    readyForCorrection,
    actionableFindingIds,
    sourceCount: current.length,
  };
  return Object.freeze({ ...payload, fingerprint: digest(payload) });
}

export function evaluateIncrementalReview({ previousHeadSha, headSha, previousReviewedFiles = [], changedFiles = [], priorRisk, currentRisk } = {}) {
  if (!SHA.test(previousHeadSha || '') || !SHA.test(headSha || '')) throw new Error('head identity is invalid');
  const previous = new Set(normalizePaths(previousReviewedFiles));
  const changed = normalizePaths(changedFiles);
  const prior = normalizeRisk(priorRisk);
  const current = normalizeRisk(currentRisk);
  if (!prior || !current) throw new Error('risk identity is invalid');
  const riskExpanded = RANK[current] > RANK[prior];
  const touchesUnreviewed = changed.some((file) => !previous.has(file));
  const eligibleForNarrowIncremental = !riskExpanded && !touchesUnreviewed && changed.length > 0;
  return Object.freeze({
    eligibleForNarrowIncremental,
    reason: riskExpanded ? 'risk-expanded' : touchesUnreviewed ? 'unreviewed-scope-changed' : changed.length === 0 ? 'no-new-change' : 'previously-reviewed-scope-only',
    previousHeadSha: previousHeadSha.toLowerCase(),
    headSha: headSha.toLowerCase(),
    // An incremental review is never represented as a full exact-head approval.
    fullExactHeadApproval: false,
    provenance: eligibleForNarrowIncremental ? 'incremental-review-candidate' : 'full-review-required',
  });
}
