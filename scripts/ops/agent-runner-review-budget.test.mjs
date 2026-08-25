import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiffFirstReviewCapsule,
  classifyReviewRisk,
  coalesceExactHeadReviewSignals,
  evaluateIncrementalReview,
  planShadowReview,
} from './agent-runner-review-budget.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function classification(risk) {
  return { risk, fingerprint: `sha256:${'1'.repeat(64)}` };
}

test('unknown scope cannot downgrade review and security/control surfaces are high or critical', () => {
  assert.equal(classifyReviewRisk().risk, 'high-risk');
  assert.equal(classifyReviewRisk({ changedFiles: ['src/server/auth/session.mjs'], structuredRisk: 'low-risk' }).risk, 'high-risk');
  assert.equal(classifyReviewRisk({ changedFiles: ['scripts/ops/source-activation.mjs'], structuredRisk: 'normal' }).risk, 'critical');
});

test('docs-only scope needs positive structured low-risk evidence before low-risk routing', () => {
  assert.equal(classifyReviewRisk({ changedFiles: ['docs/guide.md'] }).risk, 'normal');
  assert.equal(classifyReviewRisk({ changedFiles: ['docs/guide.md'], structuredRisk: 'low-risk' }).risk, 'low-risk');
});

test('deterministically failing or non-terminal head launches no independent shadow reviewer', () => {
  const normal = classification('normal');
  assert.deepEqual(planShadowReview({ classification: normal, deterministicValidation: { terminal: true, green: false } }), {
    invokeReviewer: false,
    route: null,
    reason: 'deterministic-acceptance-failed',
    correctionFirst: true,
    shadowOnly: true,
  });
  assert.equal(planShadowReview({ classification: normal, deterministicValidation: { terminal: false, green: false } }).invokeReviewer, false);
});

test('local reviewer must be explicitly review-qualified and unpaid; high-risk remains strong review', () => {
  const validation = { terminal: true, green: true };
  assert.equal(planShadowReview({ classification: classification('low-risk'), deterministicValidation: validation, localReviewer: { ready: true, reviewQualified: false, paid: false } }).route, 'independent-provider');
  assert.equal(planShadowReview({ classification: classification('low-risk'), deterministicValidation: validation, localReviewer: { ready: true, reviewQualified: true, paid: true } }).route, 'independent-provider');
  assert.equal(planShadowReview({ classification: classification('low-risk'), deterministicValidation: validation, localReviewer: { ready: true, reviewQualified: true, paid: false } }).route, 'qualified-local-reviewer');
  assert.equal(planShadowReview({ classification: classification('high-risk'), deterministicValidation: validation, localReviewer: { ready: true, reviewQualified: true, paid: false } }).route, 'strong-independent-provider');
  assert.equal(planShadowReview({ classification: classification('critical'), deterministicValidation: validation }).route, 'strong-independent-provider');
});

test('deterministic-only zero-model review remains unavailable without separate qualification', () => {
  const validation = { terminal: true, green: true };
  const unqualified = planShadowReview({ classification: classification('deterministic-only'), deterministicValidation: validation, deterministicOnlyQualified: false });
  assert.equal(unqualified.invokeReviewer, true);
  assert.equal(unqualified.route, 'strong-independent-provider');
  const qualified = planShadowReview({ classification: classification('deterministic-only'), deterministicValidation: validation, deterministicOnlyQualified: true });
  assert.equal(qualified.invokeReviewer, false);
  assert.equal(qualified.route, null);
});

test('diff-first capsule contains exact source, bounded diff and no unrelated history surface', () => {
  const capsule = buildDiffFirstReviewCapsule({
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 322,
    baseSha: BASE,
    headSha: HEAD,
    classification: classification('normal'),
    changedFiles: ['src/a.mjs'],
    diff: `diff --git a/src/a.mjs b/src/a.mjs\n${'x'.repeat(5000)}`,
    deterministicValidation: [{ id: 'canonical', status: 'success' }],
    authorityFingerprint: `sha256:${'2'.repeat(64)}`,
    maxDiffBytes: 1024,
  });
  assert.equal(capsule.diffTruncated, true);
  assert.equal(Buffer.byteLength(capsule.diff, 'utf8') <= 1024, true);
  assert.deepEqual(capsule.changedFiles, ['src/a.mjs']);
  assert.equal('issueHistory' in capsule, false);
  assert.equal('comments' in capsule, false);
  assert.equal('prompt' in capsule, false);
});

test('required exact-head CI/review signals coalesce into one correction input', () => {
  const pending = coalesceExactHeadReviewSignals({
    headSha: HEAD,
    requiredSources: ['ci', 'independent-review'],
    signals: [
      { headSha: HEAD, source: 'ci', terminal: true, severity: 'normal', findingIds: ['ci-1'] },
      { headSha: BASE, source: 'independent-review', terminal: true, severity: 'high', findingIds: ['stale-1'] },
    ],
  });
  assert.equal(pending.readyForCorrection, false);
  assert.deepEqual(pending.pendingRequired, ['independent-review']);
  assert.deepEqual(pending.actionableFindingIds, ['ci-1']);

  const ready = coalesceExactHeadReviewSignals({
    headSha: HEAD,
    requiredSources: ['ci', 'independent-review'],
    signals: [
      { headSha: HEAD, source: 'ci', terminal: true, findingIds: ['ci-1'] },
      { headSha: HEAD, source: 'independent-review', terminal: true, severity: 'high', findingIds: ['review-1'] },
    ],
  });
  assert.equal(ready.readyForCorrection, true);
  assert.deepEqual(ready.actionableFindingIds, ['ci-1', 'review-1']);
});

test('critical current-head finding can wake correction immediately', () => {
  const result = coalesceExactHeadReviewSignals({
    headSha: HEAD,
    requiredSources: ['ci', 'security-review'],
    signals: [{ headSha: HEAD, source: 'security-review', terminal: true, severity: 'critical', findingIds: ['critical-1'] }],
  });
  assert.equal(result.criticalWake, true);
  assert.equal(result.readyForCorrection, true);
  assert.deepEqual(result.pendingRequired, ['ci']);
});

test('incremental review can never masquerade as full exact-head approval', () => {
  const narrow = evaluateIncrementalReview({
    previousHeadSha: BASE,
    headSha: HEAD,
    previousReviewedFiles: ['src/a.mjs'],
    changedFiles: ['src/a.mjs'],
    priorRisk: 'normal',
    currentRisk: 'normal',
  });
  assert.equal(narrow.eligibleForNarrowIncremental, true);
  assert.equal(narrow.fullExactHeadApproval, false);
  assert.equal(narrow.provenance, 'incremental-review-candidate');

  const expanded = evaluateIncrementalReview({
    previousHeadSha: BASE,
    headSha: HEAD,
    previousReviewedFiles: ['src/a.mjs'],
    changedFiles: ['src/security/auth.mjs'],
    priorRisk: 'normal',
    currentRisk: 'high-risk',
  });
  assert.equal(expanded.eligibleForNarrowIncremental, false);
  assert.equal(expanded.fullExactHeadApproval, false);
  assert.equal(expanded.provenance, 'full-review-required');
});
