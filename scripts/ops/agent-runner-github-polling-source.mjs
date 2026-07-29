import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const GITHUB_POLLING_SCHEMA_VERSION = 1;
export const DEFAULT_POLL_OVERLAP_MS = 5 * 60_000;
export const DEFAULT_BOOTSTRAP_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_POLL_PER_PAGE = 100;
export const DEFAULT_POLL_MAX_PAGES = 20;

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid polling timestamp: ${String(value)}`);
  return date.toISOString();
}

function boundedInteger(value, fallback, { min, max, name }) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function sha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value) ? value.toLowerCase() : null;
}

function stateHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function deliveryId(parts) {
  return `poll-${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 48)}`;
}

function labelNames(item) {
  return (item?.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean).sort();
}

async function pagedArray({ requestJson, endpoint, query = {}, perPage, maxPages }) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await requestJson(endpoint, { ...query, per_page: perPage, page });
    if (!Array.isArray(payload)) throw new Error(`GitHub polling response is malformed for ${endpoint}`);
    items.push(...payload);
    if (payload.length < perPage) return { items, complete: true, pages: page };
  }
  return { items, complete: false, pages: maxPages };
}

function issueEnvelope(project, item, observedAt) {
  const number = Number(item?.number);
  if (!Number.isInteger(number) || number <= 0) throw new Error('GitHub issue polling item has invalid number');
  const updatedAt = iso(item.updated_at ?? observedAt);
  const digest = stateHash({
    number,
    state: item.state ?? null,
    stateReason: item.state_reason ?? null,
    updatedAt,
    labels: labelNames(item),
    milestone: item.milestone?.number ?? null,
    assignees: (item.assignees ?? []).map((user) => user?.login).filter(Boolean).sort(),
  });
  return Object.freeze({
    schemaVersion: 1,
    deliveryId: deliveryId([project.projectId, project.githubRepo.toLowerCase(), 'issue', String(number), updatedAt, digest]),
    receivedAt: observedAt,
    projectId: project.projectId,
    repository: project.githubRepo,
    eventName: 'issues',
    action: 'poll_observed',
    issueNumber: number,
    pullRequestNumber: null,
    headSha: null,
    baseSha: null,
    mergeSha: null,
    beforeSha: null,
    afterSha: null,
    defaultBranch: null,
    ref: null,
    refType: null,
    merged: false,
    payloadSha256: digest,
  });
}

function pullRequestEnvelope(project, item, observedAt) {
  const number = Number(item?.number);
  if (!Number.isInteger(number) || number <= 0) throw new Error('GitHub PR polling item has invalid number');
  const updatedAt = iso(item.updated_at ?? observedAt);
  const headSha = sha(item?.head?.sha);
  const baseSha = sha(item?.base?.sha);
  const merged = Boolean(item.merged_at ?? item.merged);
  const mergeSha = merged ? sha(item.merge_commit_sha) : null;
  if (!headSha || !baseSha) throw new Error(`GitHub PR #${number} is missing head/base SHA`);
  const digest = stateHash({
    number,
    state: item.state ?? null,
    draft: Boolean(item.draft),
    merged,
    mergeableState: item.mergeable_state ?? null,
    updatedAt,
    headSha,
    baseSha,
    mergeSha,
    labels: labelNames(item),
    requestedReviewers: (item.requested_reviewers ?? []).map((user) => user?.login).filter(Boolean).sort(),
  });
  return Object.freeze({
    schemaVersion: 1,
    deliveryId: deliveryId([project.projectId, project.githubRepo.toLowerCase(), 'pull-request', String(number), updatedAt, digest]),
    receivedAt: observedAt,
    projectId: project.projectId,
    repository: project.githubRepo,
    eventName: 'pull_request',
    action: 'poll_observed',
    issueNumber: null,
    pullRequestNumber: number,
    headSha,
    baseSha,
    mergeSha,
    beforeSha: null,
    afterSha: null,
    defaultBranch: item?.base?.ref ?? null,
    ref: item?.head?.ref ?? null,
    refType: 'branch',
    merged,
    payloadSha256: digest,
  });
}

function defaultBranchEnvelope(project, defaultBranch, currentSha, previousSha, observedAt) {
  const digest = stateHash({ defaultBranch, currentSha, previousSha });
  return Object.freeze({
    schemaVersion: 1,
    deliveryId: deliveryId([project.projectId, project.githubRepo.toLowerCase(), 'default-branch', currentSha, digest]),
    receivedAt: observedAt,
    projectId: project.projectId,
    repository: project.githubRepo,
    eventName: 'push',
    action: 'poll_observed',
    issueNumber: null,
    pullRequestNumber: null,
    headSha: null,
    baseSha: null,
    mergeSha: null,
    beforeSha: previousSha,
    afterSha: currentSha,
    defaultBranch,
    ref: `refs/heads/${defaultBranch}`,
    refType: 'branch',
    merged: false,
    payloadSha256: digest,
  });
}

export class GitHubPollingStore {
  constructor(dbPath, { now = () => new Date().toISOString() } = {}) {
    if (typeof dbPath !== 'string' || !dbPath) throw new Error('GitHub polling db path is required');
    this.dbPath = dbPath;
    this.now = now;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS github_polling_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_poll_cursors (
        project_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        last_success_at TEXT,
        last_default_sha TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.prepare(`INSERT OR IGNORE INTO github_polling_schema(version, applied_at) VALUES (?, ?)`)
      .run(GITHUB_POLLING_SCHEMA_VERSION, this.now());
  }

  getCursor(projectId) {
    const row = this.db.prepare(`SELECT * FROM github_poll_cursors WHERE project_id = ?`).get(projectId);
    return row ? {
      projectId: row.project_id,
      repository: row.repo,
      lastSuccessAt: row.last_success_at,
      lastDefaultSha: row.last_default_sha,
      updatedAt: row.updated_at,
    } : null;
  }

  commitCursor(project, { observedAt, defaultSha }) {
    const timestamp = iso(observedAt);
    this.db.prepare(`
      INSERT INTO github_poll_cursors(project_id, repo, last_success_at, last_default_sha, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        repo = excluded.repo,
        last_success_at = excluded.last_success_at,
        last_default_sha = excluded.last_default_sha,
        updated_at = excluded.updated_at
    `).run(project.projectId, project.githubRepo, timestamp, defaultSha, timestamp);
    return this.getCursor(project.projectId);
  }

  close() {
    this.db.close();
  }
}

async function pollOneProject({
  project,
  pollingStore,
  ingressStore,
  client,
  observedAt,
  overlapMs,
  bootstrapLookbackMs,
  perPage,
  maxPages,
}) {
  const cursor = pollingStore.getCursor(project.projectId);
  if (cursor && cursor.repository.toLowerCase() !== project.githubRepo.toLowerCase()) {
    throw new Error(`poll cursor repository mismatch for ${project.projectId}`);
  }
  const sinceBase = cursor?.lastSuccessAt
    ? Date.parse(cursor.lastSuccessAt) - overlapMs
    : Date.parse(observedAt) - bootstrapLookbackMs;
  const since = new Date(sinceBase).toISOString();
  const repoMeta = await client.requestJson(`/repos/${project.githubRepo}`, {});
  const defaultBranch = repoMeta?.default_branch;
  if (typeof defaultBranch !== 'string' || !defaultBranch) throw new Error(`default branch unavailable for ${project.githubRepo}`);
  const commit = await client.requestJson(`/repos/${project.githubRepo}/commits/${encodeURIComponent(defaultBranch)}`, {});
  const defaultSha = sha(commit?.sha);
  if (!defaultSha) throw new Error(`default branch SHA unavailable for ${project.githubRepo}`);

  const changedIssues = await pagedArray({
    requestJson: client.requestJson.bind(client),
    endpoint: `/repos/${project.githubRepo}/issues`,
    query: { state: 'all', since, sort: 'updated', direction: 'asc' },
    perPage,
    maxPages,
  });
  if (!changedIssues.complete) throw new Error(`issue polling pagination limit reached for ${project.githubRepo}`);
  const openPrs = await pagedArray({
    requestJson: client.requestJson.bind(client),
    endpoint: `/repos/${project.githubRepo}/pulls`,
    query: { state: 'open', sort: 'updated', direction: 'asc' },
    perPage,
    maxPages,
  });
  if (!openPrs.complete) throw new Error(`PR polling pagination limit reached for ${project.githubRepo}`);

  const issueItems = changedIssues.items.filter((item) => !item?.pull_request);
  const prNumbers = new Set([
    ...changedIssues.items.filter((item) => item?.pull_request).map((item) => Number(item.number)),
    ...openPrs.items.map((item) => Number(item.number)),
  ].filter((number) => Number.isInteger(number) && number > 0));
  const prItems = [];
  for (const number of [...prNumbers].sort((left, right) => left - right)) {
    prItems.push(await client.requestJson(`/repos/${project.githubRepo}/pulls/${number}`, {}));
  }

  const envelopes = [
    ...issueItems.map((item) => issueEnvelope(project, item, observedAt)),
    ...prItems.map((item) => pullRequestEnvelope(project, item, observedAt)),
  ];
  if (cursor?.lastDefaultSha !== defaultSha) {
    envelopes.push(defaultBranchEnvelope(project, defaultBranch, defaultSha, cursor?.lastDefaultSha ?? null, observedAt));
  }

  let inserted = 0;
  let duplicates = 0;
  for (const envelope of envelopes) {
    const recorded = ingressStore.recordDelivery(envelope);
    if (recorded.inserted) inserted += 1;
    else duplicates += 1;
  }
  pollingStore.commitCursor(project, { observedAt, defaultSha });
  return Object.freeze({
    projectId: project.projectId,
    repository: project.githubRepo,
    since,
    issuesObserved: issueItems.length,
    pullRequestsObserved: prItems.length,
    defaultBranch,
    defaultSha,
    deliveriesInserted: inserted,
    duplicateDeliveries: duplicates,
  });
}

export async function pollRegisteredGitHubProjects({
  registry,
  pollingStore,
  ingressStore,
  client,
  observedAt = new Date().toISOString(),
  overlapMs = DEFAULT_POLL_OVERLAP_MS,
  bootstrapLookbackMs = DEFAULT_BOOTSTRAP_LOOKBACK_MS,
  perPage = DEFAULT_POLL_PER_PAGE,
  maxPages = DEFAULT_POLL_MAX_PAGES,
} = {}) {
  if (!registry?.projects) throw new Error('project registry is required');
  if (!pollingStore?.getCursor) throw new Error('polling store is required');
  if (!ingressStore?.recordDelivery) throw new Error('event ingress store is required');
  if (!client?.requestJson) throw new Error('GitHub read client is required');
  const timestamp = iso(observedAt);
  const boundedOverlapMs = boundedInteger(overlapMs, DEFAULT_POLL_OVERLAP_MS, {
    min: 0, max: 24 * 60 * 60_000, name: 'overlapMs',
  });
  const boundedBootstrapLookbackMs = boundedInteger(bootstrapLookbackMs, DEFAULT_BOOTSTRAP_LOOKBACK_MS, {
    min: 60_000, max: 365 * 24 * 60 * 60_000, name: 'bootstrapLookbackMs',
  });
  const boundedPerPage = boundedInteger(perPage, DEFAULT_POLL_PER_PAGE, { min: 1, max: 100, name: 'perPage' });
  const boundedMaxPages = boundedInteger(maxPages, DEFAULT_POLL_MAX_PAGES, { min: 1, max: 100, name: 'maxPages' });
  const outcomes = [];
  for (const project of registry.projects) {
    try {
      outcomes.push(await pollOneProject({
        project,
        pollingStore,
        ingressStore,
        client,
        observedAt: timestamp,
        overlapMs: boundedOverlapMs,
        bootstrapLookbackMs: boundedBootstrapLookbackMs,
        perPage: boundedPerPage,
        maxPages: boundedMaxPages,
      }));
    } catch (error) {
      outcomes.push(Object.freeze({
        projectId: project.projectId,
        repository: project.githubRepo,
        errorCode: typeof error?.code === 'string' ? error.code : 'github-poll-failed',
        deliveriesInserted: 0,
        duplicateDeliveries: 0,
      }));
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    observedAt: timestamp,
    projectsInspected: registry.projects.length,
    deliveriesInserted: outcomes.reduce((sum, item) => sum + item.deliveriesInserted, 0),
    duplicateDeliveries: outcomes.reduce((sum, item) => sum + item.duplicateDeliveries, 0),
    outcomes: Object.freeze(outcomes),
  });
}
