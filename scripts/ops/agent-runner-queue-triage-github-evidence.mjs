import { evidenceFingerprint } from './agent-runner-queue-triage.mjs';

export const QUEUE_TRIAGE_GITHUB_EVIDENCE_SCHEMA_VERSION = 1;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const MAX_COMMENTS = 100;
const MAX_REVIEWS = 100;
const MAX_DEPENDENCIES = 20;
const MAX_RELEASE_SHAS = 10;
const MAX_WORKFLOW_RUNS = 20;
const MAX_EVIDENCE_REFS = 20;
const MANAGER_MARKER = '<!-- agent-runner:manager-preflight -->';
const RECOVERY_MARKERS = ['agent-runner:recovery', 'recovery forbidden', 'fresh manager review required'];
const HOLD_PHRASES = ['keep blocked', 'quarantine', 'pause', 'do not claim', 'do not retry', 'recovery forbidden', 'fresh manager review required'];
const CLAIM_MARKERS = ['<!-- agent-runner:claim -->'];
const RESERVATION_MARKERS = ['<!-- agent-runner:reservation -->'];

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function iso(value, name) { if (!nonEmpty(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`); return new Date(value).toISOString(); }
function repository(value) { if (!nonEmpty(value) || !REPOSITORY_PATTERN.test(value)) throw new Error('repository must use owner/name form'); return value; }
function positiveInteger(value, name) { if (!Number.isInteger(value) || value < 1) throw new Error(`${name} is invalid`); return value; }
function boundedText(value, max = 255) { const text = value == null ? '' : String(value); return text.length > max ? text.slice(0, max) : text; }
function uniqueStrings(values, max = 100) {
  if (!Array.isArray(values) || values.length > max) throw new Error('bounded string array is invalid');
  return Object.freeze([...new Set(values.filter(nonEmpty).map((value) => boundedText(value)))].sort());
}
function labelsFrom(issue) {
  if (!Array.isArray(issue?.labels) || issue.labels.length > 100) throw new Error('GitHub labels response is malformed');
  return uniqueStrings(issue.labels.map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean));
}
function queryCompleteDiagnostic(diagnostics, surface, code) { diagnostics.push(Object.freeze({ surface, code })); }
function responseItems(payload, field) {
  if (Array.isArray(payload)) return payload;
  if (isObject(payload) && Array.isArray(payload[field])) return payload[field];
  throw new Error(`GitHub ${field} response is malformed`);
}
function pagedRead(client, endpoint, { field, maxItems, diagnostics, surface }) {
  const perPage = Math.min(100, maxItems);
  const items = [];
  for (let page = 1; items.length < maxItems; page += 1) {
    const payload = client.requestJson(endpoint, { per_page: perPage, page });
    const pageItems = responseItems(payload, field);
    items.push(...pageItems.slice(0, maxItems - items.length));
    if (pageItems.length < perPage) return Object.freeze(items);
    if (items.length >= maxItems) {
      queryCompleteDiagnostic(diagnostics, surface, 'bounded-limit-reached');
      return Object.freeze(items);
    }
  }
  return Object.freeze(items);
}
function extractDependencyRefs(body, defaultRepository) {
  if (!nonEmpty(body)) return Object.freeze([]);
  const dependencies = body.match(/(?:^|\n)##\s+Dependencies\s*\n([\s\S]*?)(?=\n##\s+|$)/i)?.[1] ?? '';
  const refs = [];
  const seen = new Set();
  const regex = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/g;
  for (const match of dependencies.matchAll(regex)) {
    const repo = match[1] ?? defaultRepository;
    const number = Number(match[2]);
    const key = `${repo.toLowerCase()}#${number}`;
    if (!seen.has(key) && refs.length < MAX_DEPENDENCIES) {
      seen.add(key);
      refs.push(Object.freeze({ repository: repo, number }));
    }
  }
  return Object.freeze(refs);
}
function commentMarker(comment) {
  const body = boundedText(comment?.body, 64 * 1024);
  const lower = body.toLowerCase();
  const revision = body.match(/(?:^|\n)Revision:\s*`?([^`\n]+)`?/i)?.[1]?.trim() ?? null;
  const fingerprint = body.match(/(?:^|\n)Fingerprint:\s*`?(sha256:[0-9a-f]{64})`?/i)?.[1]?.toLowerCase() ?? null;
  const types = [];
  if (body.includes(MANAGER_MARKER)) types.push('manager-preflight');
  if (RECOVERY_MARKERS.some((marker) => lower.includes(marker))) types.push('recovery');
  if (CLAIM_MARKERS.some((marker) => lower.includes(marker))) types.push('claim');
  if (RESERVATION_MARKERS.some((marker) => lower.includes(marker))) types.push('reservation');
  if (types.length === 0 && !HOLD_PHRASES.some((phrase) => lower.includes(phrase))) return null;
  return Object.freeze({
    id: positiveInteger(Number(comment?.id), 'comment id'),
    updatedAt: iso(comment?.updated_at ?? comment?.created_at, 'comment timestamp'),
    types: Object.freeze(types.sort()),
    explicitHold: !body.includes(MANAGER_MARKER) && HOLD_PHRASES.some((phrase) => lower.includes(phrase)),
    active: /(?:^|\n)(?:state|status):\s*`?(?:active|claimed|reserved)`?/i.test(body),
    revision,
    fingerprint,
    bodyFingerprint: evidenceFingerprint(body),
  });
}
function normalizeCheckStatus(value) {
  const status = String(value ?? 'unknown').toLowerCase().replaceAll('-', '_');
  if (['queued', 'requested', 'waiting', 'pending', 'in_progress'].includes(status)) return 'pending';
  if (['success'].includes(status)) return 'success';
  if (['failure', 'cancelled', 'timed_out', 'action_required', 'stale'].includes(status)) return 'failure';
  if (['neutral', 'skipped'].includes(status)) return 'neutral';
  return 'unknown';
}
function collectShaEvidence(client, repo, sha, diagnostics) {
  if (!SHA_PATTERN.test(sha)) throw new Error('release SHA is invalid');
  const statuses = { pending: 0, success: 0, failure: 0, neutral: 0, unknown: 0 };
  let complete = true;
  const collect = (surface, endpoint, field, normalize) => {
    try {
      const items = pagedRead(client, endpoint, { field, maxItems: 100, diagnostics, surface: `${surface}:${sha}` });
      for (const item of items) statuses[normalize(item)] += 1;
    } catch (error) {
      complete = false;
      queryCompleteDiagnostic(diagnostics, `${surface}:${sha}`, boundedText(error?.code ?? 'provider-read-failed', 64));
    }
  };
  collect('check-runs', `/repos/${repo}/commits/${sha}/check-runs`, 'check_runs', (item) => normalizeCheckStatus(item?.status === 'completed' ? item?.conclusion : item?.status));
  collect('check-suites', `/repos/${repo}/commits/${sha}/check-suites`, 'check_suites', (item) => normalizeCheckStatus(item?.status === 'completed' ? item?.conclusion : item?.status));
  let workflowRuns = [];
  try {
    const payload = client.requestJson(`/repos/${repo}/actions/runs`, { head_sha: sha, per_page: MAX_WORKFLOW_RUNS, page: 1 });
    workflowRuns = responseItems(payload, 'workflow_runs');
    if (workflowRuns.length >= MAX_WORKFLOW_RUNS) queryCompleteDiagnostic(diagnostics, `workflow-runs:${sha}`, 'bounded-limit-reached');
    for (const item of workflowRuns.slice(0, MAX_WORKFLOW_RUNS)) statuses[normalizeCheckStatus(item?.status === 'completed' ? item?.conclusion : item?.status)] += 1;
  } catch (error) {
    complete = false;
    queryCompleteDiagnostic(diagnostics, `workflow-runs:${sha}`, boundedText(error?.code ?? 'provider-read-failed', 64));
  }
  for (const run of workflowRuns.slice(0, MAX_WORKFLOW_RUNS)) {
    if (!Number.isInteger(run?.id) || run.id < 1) { complete = false; queryCompleteDiagnostic(diagnostics, `workflow-jobs:${sha}`, 'workflow-run-missing-id'); continue; }
    collect(`workflow-jobs:${run.id}`, `/repos/${repo}/actions/runs/${run.id}/jobs`, 'jobs', (item) => normalizeCheckStatus(item?.status === 'completed' ? item?.conclusion : item?.status));
  }
  collect('commit-statuses', `/repos/${repo}/commits/${sha}/statuses`, 'statuses', (item) => normalizeCheckStatus(item?.state));
  return Object.freeze({ sha: sha.toLowerCase(), complete, statuses: Object.freeze(statuses), fingerprint: evidenceFingerprint({ sha: sha.toLowerCase(), complete, statuses }) });
}
function projectInput(project) {
  if (!isObject(project) || !nonEmpty(project.projectId)) throw new Error('project.projectId is required');
  const repo = repository(project.repository ?? project.githubRepo);
  const acceptedAgentLabels = uniqueStrings(project.acceptedAgentLabels ?? []);
  const statusLabels = isObject(project.statusLabels) ? Object.freeze({ ...project.statusLabels }) : null;
  if (!statusLabels || !nonEmpty(statusLabels.ready) || !nonEmpty(statusLabels.inProgress) || !nonEmpty(statusLabels.blocked)) throw new Error('project.statusLabels are required');
  const priorityLabels = uniqueStrings(project.priorityLabels ?? project.priorityLabelRanking ?? []);
  return Object.freeze({
    projectId: project.projectId,
    repository: repo,
    acceptedAgentLabels,
    statusLabels,
    priorityLabels,
    policy: Object.freeze({ ...(project.policy ?? project.queueTriage ?? {}) }),
  });
}
function releaseInput(release, project) {
  if (!isObject(release) || release.state !== 'pending' || !nonEmpty(release.batchId)) throw new Error('pending release is required');
  const payload = release.payload;
  if (!isObject(payload) || payload.batchId !== release.batchId || payload.projectId !== project.projectId
    || String(payload.repository ?? '').toLowerCase() !== project.repository.toLowerCase()) throw new Error('release/project identity mismatch');
  if (!['issue', 'pull_request'].includes(payload.objectKind)) throw new Error('live evidence requires issue or pull_request release');
  positiveInteger(payload.objectNumber, 'release object number');
  if (!Array.isArray(payload.shas) || payload.shas.length > MAX_RELEASE_SHAS) throw new Error('release SHAs exceed the bounded limit');
  return Object.freeze({ batchId: release.batchId, payload });
}
function issueKind(issue) { return issue?.pull_request ? 'pull_request' : 'issue'; }
function dependencyState(client, dependency, diagnostics) {
  try {
    const item = client.requestJson(`/repos/${dependency.repository}/issues/${dependency.number}`);
    if (!isObject(item) || Number(item.number) !== dependency.number) throw new Error('malformed dependency');
    return Object.freeze({ id: `${dependency.repository}#${dependency.number}`, complete: item.state === 'closed', updatedAt: iso(item.updated_at, 'dependency updatedAt') });
  } catch (error) {
    queryCompleteDiagnostic(diagnostics, `dependency:${dependency.repository}#${dependency.number}`, boundedText(error?.code ?? 'provider-read-failed', 64));
    return Object.freeze({ id: `${dependency.repository}#${dependency.number}`, complete: false, updatedAt: null });
  }
}

export function collectQueueTriageGitHubEvidence({ release, project, client, observedAt = new Date().toISOString() } = {}) {
  if (!client || typeof client.requestJson !== 'function') throw new Error('GitHub read client is required');
  const normalizedProject = projectInput(project);
  const normalizedRelease = releaseInput(release, normalizedProject);
  const diagnostics = [];
  const repoMetadata = client.requestJson(`/repos/${normalizedProject.repository}`);
  if (!isObject(repoMetadata) || String(repoMetadata.full_name ?? '').toLowerCase() !== normalizedProject.repository.toLowerCase()
    || !nonEmpty(repoMetadata.default_branch)) throw new Error('GitHub repository response is malformed');
  const defaultBranch = boundedText(repoMetadata.default_branch, 255);
  const defaultCommit = client.requestJson(`/repos/${normalizedProject.repository}/commits/${encodeURIComponent(defaultBranch)}`);
  if (!isObject(defaultCommit) || !SHA_PATTERN.test(defaultCommit.sha ?? '')) throw new Error('GitHub default branch commit response is malformed');

  const number = normalizedRelease.payload.objectNumber;
  const issue = client.requestJson(`/repos/${normalizedProject.repository}/issues/${number}`);
  if (!isObject(issue) || Number(issue.number) !== number) throw new Error('GitHub issue response is malformed');
  const kind = issueKind(issue);
  if (kind !== normalizedRelease.payload.objectKind) throw new Error('release object kind no longer matches GitHub');
  let pullRequest = null;
  let reviews = Object.freeze([]);
  if (kind === 'pull_request') {
    pullRequest = client.requestJson(`/repos/${normalizedProject.repository}/pulls/${number}`);
    if (!isObject(pullRequest) || Number(pullRequest.number) !== number) throw new Error('GitHub pull request response is malformed');
    reviews = pagedRead(client, `/repos/${normalizedProject.repository}/pulls/${number}/reviews`, {
      field: 'reviews', maxItems: MAX_REVIEWS, diagnostics, surface: `reviews:${number}`,
    });
  }
  const comments = pagedRead(client, `/repos/${normalizedProject.repository}/issues/${number}/comments`, {
    field: 'comments', maxItems: MAX_COMMENTS, diagnostics, surface: `comments:${number}`,
  });
  const markers = comments.map(commentMarker).filter(Boolean).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id);
  const bodyText = boundedText(issue.body, 128 * 1024);
  const dependencies = extractDependencyRefs(bodyText, normalizedProject.repository).map((dependency) => dependencyState(client, dependency, diagnostics));
  const latestAuthority = [...markers].reverse().find((marker) => marker.types.includes('manager-preflight') && marker.revision && marker.fingerprint) ?? null;
  const flags = Object.freeze({
    explicitHold: markers.some((marker) => marker.explicitHold),
    activeClaim: markers.some((marker) => marker.types.includes('claim') && marker.active),
    reservation: markers.some((marker) => marker.types.includes('reservation') && marker.active),
    recovery: markers.some((marker) => marker.types.includes('recovery')),
  });
  const evidenceRefs = uniqueStrings([
    `${kind}:${number}`,
    `repository:${normalizedProject.repository}`,
    `default-branch:${defaultBranch}@${String(defaultCommit.sha).toLowerCase()}`,
    ...markers.slice(-8).map((marker) => `comment:${marker.id}`),
    ...dependencies.slice(0, 8).map((dependency) => `dependency:${dependency.id}`),
  ], MAX_EVIDENCE_REFS);
  const releaseShas = [...new Set(normalizedRelease.payload.shas.map((entry) => String(entry?.sha ?? '').toLowerCase()))];
  if (releaseShas.some((sha) => !SHA_PATTERN.test(sha))) throw new Error('release SHA is invalid');
  const shaEvidence = Object.freeze(releaseShas.map((sha) => collectShaEvidence(client, normalizedProject.repository, sha, diagnostics)));
  const labels = labelsFrom(issue);
  const currentStatuses = labels.filter((label) => Object.values(normalizedProject.statusLabels).includes(label));
  const currentAgents = labels.filter((label) => normalizedProject.acceptedAgentLabels.includes(label));
  const incompleteDependency = dependencies.some((dependency) => !dependency.complete);
  const intendedStatus = flags.explicitHold ? normalizedProject.statusLabels.blocked : null;
  const authoritativeAgentLabel = currentAgents.length === 1 ? currentAgents[0] : null;
  const changedItem = Object.freeze({
    repository: normalizedProject.repository,
    kind,
    number,
    updatedAt: iso(issue.updated_at, 'GitHub object updatedAt'),
    labels,
    evidenceRefs,
    flags,
    dependencies: Object.freeze(dependencies.map(({ id, complete }) => Object.freeze({ id, complete }))),
    intendedStatus,
    intendedPriority: null,
    authoritativeAgentLabel,
    authority: latestAuthority ? Object.freeze({ revision: latestAuthority.revision, fingerprint: latestAuthority.fingerprint }) : undefined,
    linkedMergedPrComplete: false,
    postMergeSettled: false,
    remainingScope: false,
    repositoryPolicyAllowsClose: false,
    githubReady: currentStatuses.length === 1 && currentStatuses[0] === normalizedProject.statusLabels.ready && !flags.explicitHold && !incompleteDependency,
    runtimeRunnable: null,
  });
  const liveIdentity = Object.freeze({
    releaseId: normalizedRelease.batchId,
    projectId: normalizedProject.projectId,
    repository: normalizedProject.repository,
    objectKind: kind,
    objectNumber: number,
    objectState: boundedText(issue.state, 32),
    objectUpdatedAt: changedItem.updatedAt,
    labelsFingerprint: evidenceFingerprint(labels),
    defaultBranch,
    defaultBranchSha: String(defaultCommit.sha).toLowerCase(),
    releasePayloadFingerprint: evidenceFingerprint(normalizedRelease.payload),
    shaEvidenceFingerprint: evidenceFingerprint(shaEvidence),
    markerFingerprint: evidenceFingerprint(markers),
    dependencyFingerprint: evidenceFingerprint(dependencies),
  });
  const evidence = Object.freeze({
    schemaVersion: QUEUE_TRIAGE_GITHUB_EVIDENCE_SCHEMA_VERSION,
    project: normalizedProject,
    observedAt: iso(observedAt, 'observedAt'),
    mode: 'release',
    releaseId: normalizedRelease.batchId,
    changedItems: Object.freeze([changedItem]),
    rotatingItems: Object.freeze([]),
    liveEvidence: Object.freeze({
      queryComplete: diagnostics.length === 0 && shaEvidence.every((item) => item.complete),
      diagnostics: Object.freeze(diagnostics),
      identity: liveIdentity,
      commentsInspected: comments.length,
      reviewsInspected: reviews.length,
      markers: Object.freeze(markers),
      dependencies: Object.freeze(dependencies),
      shaEvidence,
      pullRequest: pullRequest ? Object.freeze({
        state: boundedText(pullRequest.state, 32),
        draft: pullRequest.draft === true,
        merged: pullRequest.merged === true,
        headSha: SHA_PATTERN.test(pullRequest.head?.sha ?? '') ? String(pullRequest.head.sha).toLowerCase() : null,
        baseSha: SHA_PATTERN.test(pullRequest.base?.sha ?? '') ? String(pullRequest.base.sha).toLowerCase() : null,
        mergeSha: SHA_PATTERN.test(pullRequest.merge_commit_sha ?? '') ? String(pullRequest.merge_commit_sha).toLowerCase() : null,
        reviewStates: Object.freeze(reviews.map((review) => boundedText(review?.state, 32)).filter(Boolean).sort()),
      }) : null,
      fingerprint: evidenceFingerprint(liveIdentity),
    }),
  });
  return evidence;
}
