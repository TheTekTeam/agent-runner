import { spawnSync } from 'node:child_process';

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A deliberately GET-only GitHub capability for #183 reconciliation. */
export class GhCliAttentionReadClient {
  constructor({ spawn = spawnSync } = {}) {
    this.spawn = spawn;
  }

  getIssue(repository, issueNumber) {
    if (!REPOSITORY.test(repository || '') || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw Object.assign(new Error('invalid issue identity'), { code: 'invalid-issue-identity' });
    }
    const endpoint = `/repos/${repository}/issues/${issueNumber}`;
    const result = this.spawn('gh', ['api', '--method', 'GET', endpoint], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 512 * 1024, windowsHide: true,
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
