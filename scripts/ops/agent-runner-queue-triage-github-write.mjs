import { spawnSync } from 'node:child_process';

const ISSUE_ENDPOINT_PATTERN = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(value, fallback, { min, max, name }) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
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

function normalizeLabels(labels) {
  if (!Array.isArray(labels) || labels.length > 100
    || !labels.every((label) => typeof label === 'string' && label.length > 0 && label.length <= 255)) {
    throw new Error('labels mutation must contain a bounded string array');
  }
  const unique = [...new Set(labels)];
  if (unique.length !== labels.length) throw new Error('labels mutation must not contain duplicates');
  return [...unique].sort();
}

export function normalizeIssueMutation(endpoint, input) {
  if (typeof endpoint !== 'string' || !ISSUE_ENDPOINT_PATTERN.test(endpoint)) {
    throw new Error('GitHub mutation endpoint is not allowlisted');
  }
  if (!isPlainObject(input)) throw new Error('GitHub mutation body must be an object');
  const keys = Object.keys(input).sort();
  if (keys.length === 1 && keys[0] === 'labels') {
    return Object.freeze({ labels: Object.freeze(normalizeLabels(input.labels)) });
  }
  if (keys.join(',') === 'state,state_reason'
    && input.state === 'closed' && input.state_reason === 'completed') {
    return Object.freeze({ state: 'closed', state_reason: 'completed' });
  }
  throw new Error('GitHub mutation body is outside the queue-triage allowlist');
}

export class GhCliGitHubWriteClient {
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
      min: 1_000,
      max: 5 * 60_000,
      name: 'timeoutMs',
    });
    this.maxOutputBytes = boundedInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, {
      min: 1_024,
      max: 10 * 1024 * 1024,
      name: 'maxOutputBytes',
    });
  }

  mutateIssue(endpoint, input) {
    const payload = normalizeIssueMutation(endpoint, input);
    const result = this.spawn('gh', ['api', '--method', 'PATCH', endpoint, '--input', '-'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: JSON.stringify(payload),
      env: this.env,
      timeout: this.timeoutMs,
      maxBuffer: this.maxOutputBytes,
    });
    if (result.error?.code === 'ETIMEDOUT') {
      const error = new Error('GitHub API write timed out');
      error.code = 'provider-timeout';
      throw error;
    }
    if (result.status !== 0) {
      const error = new Error('GitHub API write failed');
      const stderr = String(result.stderr || '').toLowerCase();
      if (stderr.includes('rate limit') || stderr.includes('secondary rate')) {
        error.code = 'provider-rate-limited';
      } else if (result.status === 4 || stderr.includes('authentication')) {
        error.code = 'provider-auth-failed';
      } else if (result.status === 403 || stderr.includes('permission')) {
        error.code = 'provider-write-forbidden';
      } else {
        error.code = 'provider-write-failed';
      }
      throw error;
    }
    try {
      return JSON.parse(result.stdout || 'null');
    } catch {
      const error = new Error('GitHub API write returned invalid JSON');
      error.code = 'provider-invalid-json';
      throw error;
    }
  }
}
