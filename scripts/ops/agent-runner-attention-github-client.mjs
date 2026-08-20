import { spawnSync } from 'node:child_process';

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENV_ALLOWLIST = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

/** A deliberately GET-only GitHub capability for #183 reconciliation. */
export class GhCliAttentionReadClient {
  constructor({ spawn = spawnSync, env = process.env } = {}) {
    this.spawn = spawn;
    this.env = Object.fromEntries(ENV_ALLOWLIST.filter((key) => env[key] != null).map((key) => [key, String(env[key])]));
  }

  getIssue(repository, issueNumber, { timeoutMs = 3_000 } = {}) {
    if (!REPOSITORY.test(repository || '') || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw Object.assign(new Error('invalid issue identity'), { code: 'invalid-issue-identity' });
    }
    const endpoint = `/repos/${repository}/issues/${issueNumber}`;
    const result = this.spawn('gh', ['api', '--method', 'GET', endpoint], {
      encoding: 'utf8', timeout: Math.max(1, Math.min(Number(timeoutMs) || 3_000, 3_000)),
      maxBuffer: 512 * 1024, windowsHide: true, env: this.env,
    });
    if (result.status !== 0 || result.error) throw Object.assign(new Error('GitHub lookup unavailable'), { code: 'lookup-unavailable' });
    let raw;
    try { raw = JSON.parse(result.stdout); } catch { throw Object.assign(new Error('GitHub lookup returned invalid JSON'), { code: 'lookup-invalid' }); }
    return Object.freeze({
      number: raw?.number,
      state: raw?.state,
      state_reason: raw?.state_reason ?? null,
      updated_at: raw?.updated_at ?? null,
      closed_at: raw?.closed_at ?? null,
      is_pull_request: Boolean(raw?.pull_request),
    });
  }
}
