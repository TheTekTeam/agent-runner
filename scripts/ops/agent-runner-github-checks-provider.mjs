import { spawnSync } from 'node:child_process';

import { normalizeCheckSnapshot } from './agent-runner-event-settlement.mjs';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WORKFLOW_RUNS_FOR_JOBS = 200;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'XDG_CONFIG_HOME',
  'GH_CONFIG_DIR',
  'GH_HOST',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
]);

function repository(value) {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) {
    throw new Error('GitHub repository must use owner/name form');
  }
  return value;
}

function commitSha(value) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new Error('GitHub commit SHA is invalid');
  }
  return value.toLowerCase();
}

function boundedInteger(value, fallback, { min, max, name }) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('observedAt is invalid');
  return date.toISOString();
}

function text(value, fallback, maxLength = 255) {
  const normalized = value == null ? fallback : String(value);
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function status(value) {
  return text(value, 'unknown', 64).toLowerCase().replaceAll('-', '_');
}

function conclusion(value) {
  return value == null ? null : status(value);
}

function uniqueChecks(checks) {
  const seen = new Set();
  const result = [];
  for (const check of checks) {
    const key = `${check.provider}:${check.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(check);
  }
  return result;
}

function checkRun(item) {
  return {
    provider: 'check_run',
    externalId: text(item?.id, `unknown-${text(item?.name, 'check')}`),
    name: text(item?.name, 'unnamed-check-run'),
    status: status(item?.status),
    conclusion: conclusion(item?.conclusion),
  };
}

function checkSuite(item) {
  return {
    provider: 'check_suite',
    externalId: text(item?.id, `unknown-${text(item?.app?.slug, 'suite')}`),
    name: text(item?.app?.slug ?? item?.app?.name, 'unnamed-check-suite'),
    status: status(item?.status),
    conclusion: conclusion(item?.conclusion),
  };
}

function workflowRun(item) {
  return {
    provider: 'workflow_run',
    externalId: text(item?.id, `unknown-${text(item?.name, 'workflow')}`),
    name: text(item?.name ?? item?.display_title, 'unnamed-workflow-run'),
    status: status(item?.status),
    conclusion: conclusion(item?.conclusion),
  };
}

function workflowJob(item) {
  return {
    provider: 'workflow_job',
    externalId: text(item?.id, `unknown-${text(item?.name, 'job')}`),
    name: text(item?.name, 'unnamed-workflow-job'),
    status: status(item?.status),
    conclusion: conclusion(item?.conclusion),
  };
}

function commitStatus(item) {
  return {
    provider: 'commit_status',
    externalId: text(item?.id ?? item?.context, 'unknown-status'),
    name: text(item?.context, 'unnamed-commit-status'),
    status: status(item?.state),
    conclusion: item?.state === 'pending' ? null : conclusion(item?.state),
  };
}

function pageItems(payload, field) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[field])) return payload[field];
  throw new Error(`GitHub ${field} response is malformed`);
}

async function pagedCollection({
  requestJson,
  endpoint,
  query,
  field,
  normalize,
  perPage,
  maxPages,
}) {
  const collected = [];
  const rawItems = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await requestJson(endpoint, { ...query, per_page: perPage, page });
    const items = pageItems(payload, field);
    rawItems.push(...items);
    collected.push(...items.map(normalize));
    if (items.length < perPage) return { checks: collected, items: rawItems, complete: true, pages: page };
  }
  return { checks: collected, items: rawItems, complete: false, pages: maxPages, reasonCode: 'pagination-limit-reached' };
}

function diagnostic(surface, reasonCode) {
  return Object.freeze({ surface, reasonCode });
}

export async function collectGitHubCheckSnapshot({
  repository: repositoryName,
  sha,
  requestJson,
  observedAt = new Date().toISOString(),
  perPage = DEFAULT_PER_PAGE,
  maxPages = DEFAULT_MAX_PAGES,
  maxWorkflowRunsForJobs = DEFAULT_MAX_WORKFLOW_RUNS_FOR_JOBS,
} = {}) {
  const repo = repository(repositoryName);
  const normalizedSha = commitSha(sha);
  if (typeof requestJson !== 'function') throw new Error('requestJson function is required');
  const boundedPerPage = boundedInteger(perPage, DEFAULT_PER_PAGE, { min: 1, max: 100, name: 'perPage' });
  const boundedMaxPages = boundedInteger(maxPages, DEFAULT_MAX_PAGES, { min: 1, max: 100, name: 'maxPages' });
  const boundedMaxWorkflowRunsForJobs = boundedInteger(
    maxWorkflowRunsForJobs,
    DEFAULT_MAX_WORKFLOW_RUNS_FOR_JOBS,
    { min: 1, max: 1_000, name: 'maxWorkflowRunsForJobs' },
  );
  const diagnostics = [];
  const checks = [];
  let queryComplete = true;

  const surfaces = [
    {
      name: 'check-runs',
      endpoint: `/repos/${repo}/commits/${normalizedSha}/check-runs`,
      query: {},
      field: 'check_runs',
      normalize: checkRun,
    },
    {
      name: 'check-suites',
      endpoint: `/repos/${repo}/commits/${normalizedSha}/check-suites`,
      query: {},
      field: 'check_suites',
      normalize: checkSuite,
    },
    {
      name: 'workflow-runs',
      endpoint: `/repos/${repo}/actions/runs`,
      query: { head_sha: normalizedSha },
      field: 'workflow_runs',
      normalize: workflowRun,
    },
    {
      name: 'commit-statuses',
      endpoint: `/repos/${repo}/commits/${normalizedSha}/statuses`,
      query: {},
      field: 'statuses',
      normalize: commitStatus,
    },
  ];

  let workflowRuns = [];
  for (const surface of surfaces) {
    try {
      const result = await pagedCollection({
        requestJson,
        endpoint: surface.endpoint,
        query: surface.query,
        field: surface.field,
        normalize: surface.normalize,
        perPage: boundedPerPage,
        maxPages: boundedMaxPages,
      });
      checks.push(...result.checks);
      if (surface.name === 'workflow-runs') workflowRuns = result.items;
      if (!result.complete) {
        queryComplete = false;
        diagnostics.push(diagnostic(surface.name, result.reasonCode));
      }
    } catch (error) {
      queryComplete = false;
      diagnostics.push(diagnostic(surface.name, text(error?.code, 'provider-read-failed', 64)));
    }
  }

  if (workflowRuns.length > boundedMaxWorkflowRunsForJobs) {
    queryComplete = false;
    diagnostics.push(diagnostic('workflow-jobs', 'workflow-run-limit-reached'));
  }
  for (const run of workflowRuns.slice(0, boundedMaxWorkflowRunsForJobs)) {
    if (!Number.isInteger(run?.id) || run.id <= 0) {
      queryComplete = false;
      diagnostics.push(diagnostic('workflow-jobs', 'workflow-run-missing-id'));
      continue;
    }
    try {
      const result = await pagedCollection({
        requestJson,
        endpoint: `/repos/${repo}/actions/runs/${run.id}/jobs`,
        query: {},
        field: 'jobs',
        normalize: workflowJob,
        perPage: boundedPerPage,
        maxPages: boundedMaxPages,
      });
      checks.push(...result.checks);
      if (!result.complete) {
        queryComplete = false;
        diagnostics.push(diagnostic(`workflow-jobs:${run.id}`, result.reasonCode));
      }
    } catch (error) {
      queryComplete = false;
      diagnostics.push(diagnostic(`workflow-jobs:${run.id}`, text(error?.code, 'provider-read-failed', 64)));
    }
  }

  return Object.freeze({
    snapshot: normalizeCheckSnapshot({
      sha: normalizedSha,
      observedAt: iso(observedAt),
      queryComplete,
      checks: uniqueChecks(checks),
    }),
    diagnostics: Object.freeze(diagnostics),
  });
}

function childEnvironment(env) {
  const child = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (env[name] != null) child[name] = String(env[name]);
  }
  child.GH_PAGER = 'cat';
  child.NO_COLOR = '1';
  return child;
}

function queryArgs(query) {
  return Object.entries(query)
    .filter(([, value]) => value != null)
    .flatMap(([name, value]) => ['-f', `${name}=${String(value)}`]);
}

export class GhCliGitHubReadClient {
  constructor({
    spawn = spawnSync,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = {}) {
    if (typeof spawn !== 'function') throw new Error('spawn function is required');
    this.spawn = spawn;
    this.env = childEnvironment(env);
    this.timeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, {
      min: 1_000, max: 5 * 60_000, name: 'timeoutMs',
    });
    this.maxOutputBytes = boundedInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, {
      min: 1_024, max: 50 * 1024 * 1024, name: 'maxOutputBytes',
    });
  }

  requestJson(endpoint, query = {}) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/repos/')) {
      throw new Error('GitHub API endpoint is not allowlisted');
    }
    const args = ['api', '--method', 'GET', endpoint, ...queryArgs(query)];
    const result = this.spawn('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.env,
      timeout: this.timeoutMs,
      maxBuffer: this.maxOutputBytes,
    });
    if (result.error?.code === 'ETIMEDOUT') {
      const error = new Error('GitHub API read timed out');
      error.code = 'provider-timeout';
      throw error;
    }
    if (result.status !== 0) {
      const error = new Error('GitHub API read failed');
      const stderr = String(result.stderr || '').toLowerCase();
      if (stderr.includes('rate limit') || stderr.includes('secondary rate')) {
        error.code = 'provider-rate-limited';
      } else {
        error.code = result.status === 4 ? 'provider-auth-failed' : 'provider-read-failed';
      }
      throw error;
    }
    try {
      return JSON.parse(result.stdout || 'null');
    } catch {
      const error = new Error('GitHub API returned invalid JSON');
      error.code = 'provider-invalid-json';
      throw error;
    }
  }
}

export async function refreshBatchGitHubCheckSnapshots({
  settlementStore,
  batchId,
  client,
  observedAt = new Date().toISOString(),
  perPage = DEFAULT_PER_PAGE,
  maxPages = DEFAULT_MAX_PAGES,
  maxWorkflowRunsForJobs = DEFAULT_MAX_WORKFLOW_RUNS_FOR_JOBS,
} = {}) {
  if (!settlementStore || typeof settlementStore.getBatch !== 'function') {
    throw new Error('settlementStore is required');
  }
  if (!client || typeof client.requestJson !== 'function') throw new Error('GitHub read client is required');
  const batch = settlementStore.getBatch(batchId);
  if (!batch) throw new Error(`unknown event batch: ${batchId}`);
  const results = [];
  for (const requiredSha of settlementStore.requiredShas(batchId)) {
    const collected = await collectGitHubCheckSnapshot({
      repository: batch.repository,
      sha: requiredSha,
      requestJson: client.requestJson.bind(client),
      observedAt,
      perPage,
      maxPages,
      maxWorkflowRunsForJobs,
    });
    settlementStore.recordCheckSnapshot(batchId, collected.snapshot);
    results.push(Object.freeze({ sha: requiredSha, ...collected }));
  }
  return Object.freeze(results);
}
