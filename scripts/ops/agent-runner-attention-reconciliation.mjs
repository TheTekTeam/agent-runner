import { createHash, randomUUID } from 'node:crypto';

export const ATTENTION_RECONCILIATION_SCHEMA_VERSION = 2;
export const ATTENTION_RECONCILIATION_MAX_AGE_MS = 30 * 60 * 1000;
export const ATTENTION_RECONCILIATION_MAX_EVENTS = 200;
export const ATTENTION_RECONCILIATION_MAX_ISSUES = 25;
export const ATTENTION_RECONCILIATION_TOTAL_LOOKUP_MS = 15_000;
export const ATTENTION_RECONCILIATION_PER_LOOKUP_MS = 3_000;

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const hash = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export function attentionEventIdentity(row) {
  if (!REPOSITORY.test(row?.repo || '') || !Number.isInteger(row?.issue_number) || row.issue_number <= 0) return null;
  const hasId = Number.isInteger(row.id) && row.id > 0;
  const hasKeys = typeof row.dedupe_key === 'string' && row.dedupe_key && typeof row.attempt_id === 'string' && row.attempt_id;
  if (!hasId && !hasKeys) return null;
  return hash({ repository: row.repo, id: hasId ? row.id : null, dedupeKey: hash(row.dedupe_key || ''), attemptId: hash(row.attempt_id || '') });
}

function currentAttemptProof(row, attempts = []) {
  const attempt = attempts.find((candidate) => candidate?.attempt_id === row?.attempt_id);
  if (!attempt || attempt.attention_dedupe_key !== row.dedupe_key) return null;
  const revision = hash({
    attemptId: hash(attempt.attempt_id), resolutionState: attempt.resolution_state || null,
    attentionStatus: attempt.attention_status || null, outcome: attempt.outcome || null,
    finishedAt: attempt.finished_at || null,
  });
  const actionable = attempt.attention_status === 'attention_required'
    && attempt.resolution_state === 'operator_attention_required';
  return Object.freeze({ actionable, revision });
}

export function attentionEventRevision(row, attempts = []) {
  return hash({
    eventKey: attentionEventIdentity(row), updatedAt: row?.updated_at || null, resolvedAt: row?.resolved_at || null,
    recoveryStatus: row?.recovery_status || null, policyRevision: row?.policy_revision || null,
    reasonDigest: hash(row?.reason || ''), nextActionDigest: hash(row?.next_action || ''),
    eventDigest: hash(row?.event_json || ''), attemptRevision: currentAttemptProof(row, attempts)?.revision || null,
  });
}

export function attentionSourceSnapshotDigest(attentionEvents = [], attempts = []) {
  return hash(attentionEvents.filter((row) => !row?.resolved_at).map((row) => ({
    eventKey: attentionEventIdentity(row), eventRevision: attentionEventRevision(row, attempts),
  })).sort((a, b) => String(a.eventKey).localeCompare(String(b.eventKey))));
}

export function classifyGithubIssueState(issue, { hasCurrentActionProof = false } = {}) {
  if (!issue || typeof issue !== 'object' || typeof issue.state !== 'string') return Object.freeze({ status: 'unknown', reasonCode: 'issue-not-found' });
  if (issue.state === 'closed') {
    const reason = typeof issue.state_reason === 'string' && issue.state_reason ? issue.state_reason : 'unspecified';
    return Object.freeze({ status: 'historical', reasonCode: `closed-${reason}` });
  }
  if (issue.state === 'open' && hasCurrentActionProof) return Object.freeze({ status: 'actionable', reasonCode: 'current-operator-hold' });
  if (issue.state === 'open') return Object.freeze({ status: 'unknown', reasonCode: 'open-without-current-action-proof' });
  return Object.freeze({ status: 'unknown', reasonCode: 'issue-state-unrecognized' });
}

function githubEvidenceRevision(repository, issue, errorCode = null) {
  return hash(errorCode ? { repository, errorCode } : {
    repository, number: issue?.number, state: issue?.state, stateReason: issue?.state_reason ?? null,
    updatedAt: issue?.updated_at ?? null, closedAt: issue?.closed_at ?? null,
    isPullRequest: Boolean(issue?.is_pull_request),
  });
}

export function reconcileAttentionEvent({ row, attempts = [], githubResult, checkedAt }) {
  const eventKey = attentionEventIdentity(row);
  const eventRevision = attentionEventRevision(row, attempts);
  const proof = currentAttemptProof(row, attempts);
  let issue = githubResult?.issue ?? null;
  let errorCode = githubResult?.errorCode ?? null;
  if (!eventKey) errorCode = 'invalid-attention-event-identity';
  if (!errorCode && (!issue || issue.number !== row.issue_number)) errorCode = 'lookup-ambiguous';
  const classified = errorCode
    ? { status: 'unknown', reasonCode: errorCode }
    : classifyGithubIssueState(issue, { hasCurrentActionProof: proof?.actionable === true });
  return Object.freeze({
    repository: row?.repo || null, eventKey, eventRevision,
    attentionEventId: Number.isInteger(row?.id) ? row.id : null,
    issueNumber: Number.isInteger(row?.issue_number) ? row.issue_number : null,
    status: classified.status, reasonCode: classified.reasonCode,
    githubState: errorCode ? null : issue.state,
    githubStateReason: errorCode ? null : issue.state_reason ?? null,
    githubEvidenceRevision: githubEvidenceRevision(row?.repo, issue, errorCode), checkedAt,
  });
}

export function reconcileAttentionEvents({ repository, attentionEvents = [], attempts = [], store, client,
  now = () => new Date().toISOString(), clock = () => Date.now(), generationId = randomUUID(),
  maxAgeMs = ATTENTION_RECONCILIATION_MAX_AGE_MS, totalLookupMs = ATTENTION_RECONCILIATION_TOTAL_LOOKUP_MS,
  perLookupMs = ATTENTION_RECONCILIATION_PER_LOOKUP_MS, verifySource = () => true } = {}) {
  if (!REPOSITORY.test(repository || '')) throw new Error('repository is required');
  if (!store || typeof store.publishGeneration !== 'function') throw new Error('reconciliation store is required');
  if (!client || typeof client.getIssue !== 'function') throw new Error('GET-only attention client is required');
  const unresolved = attentionEvents.filter((row) => !row?.resolved_at && row?.repo === repository);
  if (unresolved.length > ATTENTION_RECONCILIATION_MAX_EVENTS) throw Object.assign(new Error('attention event bound exceeded'), { code: 'attention-event-bound-exceeded' });
  const identities = [...new Set(unresolved.map((row) => `${row.repo}#${row.issue_number}`))];
  if (identities.length > ATTENTION_RECONCILIATION_MAX_ISSUES) throw Object.assign(new Error('attention issue bound exceeded'), { code: 'attention-issue-bound-exceeded' });
  const startedAt = now();
  const deadline = clock() + totalLookupMs;
  const cache = new Map();
  for (const row of unresolved) {
    const key = `${row.repo}#${row.issue_number}`;
    if (cache.has(key)) continue;
    const remainingMs = deadline - clock();
    if (remainingMs <= 0) { cache.set(key, { errorCode: 'lookup-budget-exhausted' }); continue; }
    try { cache.set(key, { issue: client.getIssue(row.repo, row.issue_number, { timeoutMs: Math.min(perLookupMs, remainingMs) }) }); }
    catch { cache.set(key, { errorCode: 'lookup-unavailable' }); }
  }
  const decisions = unresolved.map((row) => reconcileAttentionEvent({
    row, attempts, githubResult: cache.get(`${row.repo}#${row.issue_number}`), checkedAt: now(),
  }));
  if (!verifySource()) throw Object.assign(new Error('attention source changed during reconciliation'), { code: 'attention-source-changed' });
  const completedAt = now();
  return store.publishGeneration({
    generationId, repository, sourceSnapshotDigest: attentionSourceSnapshotDigest(unresolved, attempts),
    sourceEventCount: unresolved.length, startedAt, completedAt,
    expiresAt: new Date(Date.parse(completedAt) + maxAgeMs).toISOString(), decisions,
    checkedIssueCount: identities.length,
  });
}

export function buildAttentionReconciliationProjection(attentionEvents = [], attempts = [], state = null, {
  repository = null, now = new Date().toISOString(), sourceTotal = null, sourceOverflow = false,
} = {}) {
  const unresolved = attentionEvents.filter((row) => !row?.resolved_at && (!repository || row?.repo === repository));
  const exactSourceTotal = Number.isInteger(sourceTotal) && sourceTotal >= unresolved.length ? sourceTotal : unresolved.length;
  if (sourceOverflow || exactSourceTotal > ATTENTION_RECONCILIATION_MAX_EVENTS) {
    const items = unresolved.slice(0, ATTENTION_RECONCILIATION_MAX_EVENTS).map((row) => Object.freeze({
      eventKey: attentionEventIdentity(row), repository: row?.repo || null, issueNumber: row?.issue_number || null,
      status: 'unknown', reasonCode: 'attention-event-bound-exceeded', checkedAt: null, acknowledged: false,
    }));
    return Object.freeze({
      schemaVersion: ATTENTION_RECONCILIATION_SCHEMA_VERSION, repository, generatedAt: now,
      generation: Object.freeze({ ...(state?.generation || { id: null }), freshness: 'overflow' }),
      items: Object.freeze(items),
      counts: Object.freeze({ actionable: 0, historical: 0, unknown: exactSourceTotal, stale: 0, total: exactSourceTotal }),
      posture: 'degraded',
    });
  }
  const sourceDigest = attentionSourceSnapshotDigest(unresolved, attempts);
  const generationFresh = state?.generation?.state === 'completed'
    && state.generation.sourceSnapshotDigest === sourceDigest
    && Date.parse(state.generation.expiresAt) > Date.parse(now);
  const itemsByKey = new Map((state?.items || []).map((item) => [item.eventKey, item]));
  const revoked = new Set((state?.acknowledgements || []).filter((ack) => ack.action === 'revoke').map((ack) => ack.targetId));
  const grants = new Map();
  for (const ack of state?.acknowledgements || []) {
    if (ack.action !== 'grant' || revoked.has(ack.id) || Date.parse(ack.expiresAt) <= Date.parse(now)) continue;
    grants.set(`${ack.eventKey}|${ack.eventRevision}|${ack.githubEvidenceRevision}`, ack);
  }
  const items = unresolved.map((row) => {
    const eventKey = attentionEventIdentity(row);
    const eventRevision = attentionEventRevision(row, attempts);
    const recorded = generationFresh ? itemsByKey.get(eventKey) : null;
    let status = generationFresh ? 'unknown' : (state?.generation ? 'stale' : 'unknown');
    let reasonCode = generationFresh ? 'not-reconciled' : (state?.generation ? 'reconciliation-stale-or-source-changed' : 'reconciliation-missing');
    let acknowledged = false;
    if (recorded && recorded.eventRevision === eventRevision) {
      status = recorded.status; reasonCode = recorded.reasonCode;
      const ack = grants.get(`${eventKey}|${recorded.eventRevision}|${recorded.githubEvidenceRevision}`);
      if (ack) { status = ack.status; reasonCode = ack.reasonCode; acknowledged = true; }
    }
    return Object.freeze({
      eventKey, repository: row?.repo || null, issueNumber: row?.issue_number || null,
      status, reasonCode, checkedAt: recorded?.checkedAt || null, acknowledged,
    });
  });
  const count = (value) => items.filter((item) => item.status === value).length;
  const actionableCount = count('actionable'); const unknownCount = count('unknown'); const staleCount = count('stale');
  return Object.freeze({
    schemaVersion: ATTENTION_RECONCILIATION_SCHEMA_VERSION, repository,
    generatedAt: now,
    generation: state?.generation ? Object.freeze({ ...state.generation, freshness: generationFresh ? 'current' : 'stale' }) : Object.freeze({ id: null, freshness: 'missing' }),
    items: Object.freeze(items),
    counts: Object.freeze({ actionable: actionableCount, historical: count('historical'), unknown: unknownCount, stale: staleCount, total: items.length }),
    posture: actionableCount > 0 ? 'attention' : (unknownCount + staleCount > 0 ? 'degraded' : 'clear'),
  });
}
