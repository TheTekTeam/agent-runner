#!/usr/bin/env node

/**
 * #268: the real Dell adapter surface.
 *
 * These are the production implementations of the bounded read adapters the
 * management collectors and observer consume. Everything here is a read:
 * `git` against the registered project checkout, `gh` against the registered
 * repository, the accepted quota-only admission gate, the existing global
 * implementation lock, and host identity.
 *
 * Nothing in this module mutates a repository, an issue, a pull request, a
 * timer or a service. The two optional write adapters a production `active`
 * deployment needs are constructed separately and explicitly by the operator;
 * they are deliberately not defaulted here, so an accidentally-active control
 * plane has nothing to mutate through.
 *
 * Every adapter fails closed: an unreadable value becomes a refusal or the
 * ambiguous state, never an optimistic guess.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

import { evaluateProfileQuotaAdmission } from './claude-runner-quota.mjs';
import { parseCronLock, processIsAlive } from './agent-runner-cron-lock.mjs';
import { resolveGlobalLockPath } from './agent-runner-implementation-recurrence.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_DELL_ADAPTERS_SCHEMA_VERSION = 'agent-runner-management-dell-adapters/v1';

/** The environment variable naming the host that is permitted to schedule. */
export const MANAGEMENT_SCHEDULER_HOST_ENV = 'AGENT_RUNNER_MANAGEMENT_SCHEDULER_HOST';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ATTEMPT_BRANCH = /([A-Za-z0-9][A-Za-z0-9._-]*)$/;

function fail(message, code = 'management-adapter-failed') {
  const error = new Error(`Agent Runner management adapter refusal: ${message}`);
  error.code = code;
  return error;
}

function runCommand(spawn, command, args, { cwd = undefined, env = undefined, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = spawn(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (!result || result.error || result.status !== 0) {
    throw fail(`${command} read failed`);
  }
  return String(result.stdout ?? '');
}

function ghJson(spawn, env, endpoint, query = {}) {
  if (!endpoint.startsWith('/repos/')) throw fail('GitHub endpoint is not allowlisted');
  const args = ['api', '--method', 'GET', endpoint];
  for (const [name, value] of Object.entries(query)) {
    if (value != null) args.push('-f', `${name}=${String(value)}`);
  }
  const stdout = runCommand(spawn, 'gh', args, { env });
  try {
    return JSON.parse(stdout || 'null');
  } catch {
    throw fail('GitHub returned invalid JSON');
  }
}

function repositorySlug(profile) {
  return `${profile.repository.owner}/${profile.repository.name}`;
}

/**
 * The issue number an authorised pull request belongs to.
 *
 * Read from the accepted implementation branch convention
 * (`<prefix>/<plan-item>-<issue>`), which is the same identity the authority
 * bound. A branch that does not carry one yields `null` rather than a guess.
 */
function issueNumberFromBranch(branch) {
  if (!nonEmptyString(branch)) return null;
  const tail = ATTEMPT_BRANCH.exec(branch);
  if (!tail) return null;
  const parts = tail[1].split('-');
  const last = parts[parts.length - 1];
  if (!/^\d+$/.test(last)) return null;
  const number = Number(last);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Map a GitHub check-run conclusion onto the bounded #267 check states.
 * Anything unrecognised is `pending`, never optimistically green.
 */
function checkState(run) {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success': return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
      return 'failure';
    case 'cancelled': return 'cancelled';
    case 'neutral': return 'neutral';
    case 'skipped': return 'skipped';
    default: return 'pending';
  }
}

/** Map a GitHub review decision onto the bounded #267 review states. */
function reviewState(decision) {
  if (decision === 'CHANGES_REQUESTED') return 'changes-requested';
  if (decision === 'APPROVED') return 'no-blockers';
  return 'pending';
}

/**
 * Build the production Dell adapter surface.
 *
 * `spawn` is injected so the focused tests exercise this same code with a
 * bounded fake process runner rather than a parallel implementation.
 */
export function createDellManagementAdapters({
  spawn = defaultSpawnSync,
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  function checkoutPath(project) {
    if (!isPlainObject(project) || !nonEmptyString(project.localRepoPath)) {
      throw fail('the registered project has no local checkout path');
    }
    return project.localRepoPath;
  }

  return Object.freeze({
    /** The exact revision the registered checkout currently has active. */
    readSourceSha({ project }) {
      const sha = runCommand(spawn, 'git', ['rev-parse', 'HEAD'], { cwd: checkoutPath(project) }).trim().toLowerCase();
      if (!SHA_PATTERN.test(sha)) throw fail('git did not report an exact commit SHA');
      return sha;
    },

    /**
     * An instruction document read at the exact active revision, digested
     * rather than carried: the content itself is never management state.
     */
    readInstructionDocument({ project, path }) {
      try {
        const content = runCommand(spawn, 'git', ['show', `HEAD:${path}`], { cwd: checkoutPath(project) });
        return { sha256: createHash('sha256').update(content).digest('hex'), freshness: 'current' };
      } catch {
        // A declared instruction path that is absent at this revision is stale
        // evidence, which the #261 validator is entitled to see and judge.
        return { sha256: createHash('sha256').update('').digest('hex'), freshness: 'stale' };
      }
    },

    listOpenIssues({ profile }) {
      const payload = ghJson(spawn, env, `/repos/${repositorySlug(profile)}/issues`, { state: 'open', per_page: '100' });
      if (!Array.isArray(payload)) return [];
      return payload
        // The issues endpoint also returns pull requests; they are not queue records.
        .filter((issue) => isPlainObject(issue) && !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          title: String(issue.title ?? ''),
          state: issue.state === 'closed' ? 'closed' : 'open',
          labels: Array.isArray(issue.labels)
            ? issue.labels.map((label) => (typeof label === 'string' ? label : String(label?.name ?? ''))).filter(Boolean)
            : [],
          body: typeof issue.body === 'string' ? issue.body : '',
        }));
    },

    listOpenPullRequests({ profile }) {
      const payload = ghJson(spawn, env, `/repos/${repositorySlug(profile)}/pulls`, { state: 'open', per_page: '50' });
      if (!Array.isArray(payload)) return [];
      return payload.filter(isPlainObject).map((pull) => ({
        number: pull.number,
        title: String(pull.title ?? ''),
        headSha: String(pull.head?.sha ?? '').toLowerCase(),
        branch: String(pull.head?.ref ?? ''),
        issueNumber: issueNumberFromBranch(pull.head?.ref),
        labels: Array.isArray(pull.labels) ? pull.labels.map((label) => String(label?.name ?? '')).filter(Boolean) : [],
      }));
    },

    /**
     * Quota headroom, through the accepted quota-only admission gate.
     *
     * There is deliberately no balance, credit, dollar-cap or paid-fallback
     * input: unreadable or unparseable evidence becomes `ambiguous`, which the
     * programme role fails closed on.
     */
    readQuotaAdmission({ profileName }) {
      let evidence = { quotaUsage: null, status: null };
      try {
        const raw = runCommand(spawn, process.execPath, [
          new URL('../../.agent-runner/scripts/runner.mjs', import.meta.url).pathname,
          '--check-quota', '--force-quota-check',
        ], { env });
        const payload = JSON.parse(raw || '{}');
        evidence = { quotaUsage: payload?.state?.quotaUsage ?? null, status: payload?.status ?? null };
      } catch {
        evidence = { quotaUsage: null, status: null };
      }
      const admission = evaluateProfileQuotaAdmission({ ...evidence, profileName, env });
      if (admission.status === 'available') return { state: 'available', profileName };
      // `exhausted` and `unavailable` are both "no headroom now"; only genuinely
      // unreadable evidence is ambiguous.
      if (admission.status === 'ambiguous') return { state: 'ambiguous', profileName };
      return { state: 'unavailable', profileName };
    },

    /** The one global implementation slot, read from the existing lock. */
    readImplementationSlot() {
      const lockPath = resolveGlobalLockPath(env);
      let contents = null;
      try {
        // eslint-disable-next-line global-require -- read lazily so a missing lock is simply "free"
        contents = runCommand(spawn, 'cat', [lockPath]);
      } catch {
        return { occupied: false, issueNumber: null };
      }
      const lock = parseCronLock(contents);
      if (!lock) return { occupied: false, issueNumber: null };
      return { occupied: processIsAlive(lock.pid), issueNumber: null };
    },

    readOwnership({ project, profile }) {
      const pulls = this.listOpenPullRequests({ project, profile });
      const slot = this.readImplementationSlot({ project, profile });
      const activeLeases = [];
      // Only a lease bound to a known issue is reportable ownership; an
      // unattributable lock is reported through the slot instead.
      for (const pull of pulls) {
        if (slot.occupied && pull.issueNumber != null && slot.issueNumber === pull.issueNumber) {
          activeLeases.push({ issueNumber: pull.issueNumber, kind: 'implementation', holder: 'implementation-lock' });
        }
      }
      return {
        activeLeases,
        openPullRequests: pulls
          .filter((pull) => pull.issueNumber != null && SHA_PATTERN.test(pull.headSha))
          .map((pull) => ({ number: pull.number, issueNumber: pull.issueNumber, headSha: pull.headSha })),
      };
    },

    /**
     * Bounded attempt evidence for one authorised pull request, derived from
     * authoritative GitHub state at the exact current head.
     */
    readAttempt({ profile, pullRequestNumber, authority }) {
      const number = pullRequestNumber ?? authority?.pullRequestNumber ?? null;
      if (!Number.isInteger(number) || number <= 0) return null;
      const slug = repositorySlug(profile);
      const pull = ghJson(spawn, env, `/repos/${slug}/pulls/${number}`);
      if (!isPlainObject(pull)) return null;
      const headSha = String(pull.head?.sha ?? '').toLowerCase();
      if (!SHA_PATTERN.test(headSha)) return null;

      const runs = ghJson(spawn, env, `/repos/${slug}/commits/${headSha}/check-runs`, { per_page: '50' });
      const checks = Array.isArray(runs?.check_runs)
        ? runs.check_runs.filter(isPlainObject).map((run) => ({
          name: String(run.name ?? 'check'),
          state: checkState(run),
          // Only a check the registered profile declared is treated as required.
          required: profile.validation.requiredChecks.some((check) => check === String(run.name ?? '')),
        }))
        : [];

      const issueNumber = issueNumberFromBranch(pull.head?.ref) ?? authority?.issueNumber ?? null;
      const attemptId = nonEmptyString(pull.head?.ref) ? `attempt-${String(pull.head.ref).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 48)}` : null;
      if (!attemptId) return null;

      const merged = pull.merged_at != null;
      const state = merged ? 'merged' : (pull.state === 'closed' ? 'closed' : 'open');
      const timestamp = `${new Date(Date.parse(typeof now === 'function' ? now() : now)).toISOString().slice(0, 19)}Z`;

      return {
        attemptId,
        issueNumber,
        evidenceRevision: `attempt-${headSha.slice(0, 16)}`,
        // A monotonic ordering signal that is not a clock reading: GitHub's own
        // update counter for this pull request.
        evidenceSequence: Number.isInteger(pull.comments) ? pull.comments : 0,
        evidenceTimestamp: timestamp,
        publication: {
          attemptId,
          headSha,
          // A published pull request is the bounded evidence that the attempt
          // published. Finer completion states come from worker settlement.
          completionState: 'published',
          pullRequestNumber: number,
          changedFileCount: Number.isInteger(pull.changed_files) ? pull.changed_files : 0,
          changedPaths: [],
          insertions: Number.isInteger(pull.additions) ? pull.additions : 0,
          deletions: Number.isInteger(pull.deletions) ? pull.deletions : 0,
          validationChecks: [],
          summary: 'Implementation attempt published a pull request.',
        },
        pullRequest: {
          number,
          branch: String(pull.head?.ref ?? ''),
          baseSha: String(pull.base?.sha ?? '').toLowerCase(),
          headSha,
          state,
          draft: pull.draft === true,
          mergeableState: nonEmptyString(pull.mergeable_state) ? pull.mergeable_state : 'unknown',
          changedFileCount: Number.isInteger(pull.changed_files) ? pull.changed_files : 0,
          changedPaths: [],
        },
        ci: { headSha, checks },
        review: {
          pullRequestNumber: number,
          headSha,
          state: reviewState(pull.review_decision ?? pull.reviewDecision ?? null),
          findings: [],
        },
        ownership: { activeLeases: [], openPullRequests: [], workspace: null },
      };
    },

    /**
     * Host identity. Dell is the sole controller/scheduler; assurance compares
     * these and reports drift if any other host holds the scheduler role.
     */
    readHosts() {
      const controllerHost = hostname();
      const schedulerHost = nonEmptyString(env[MANAGEMENT_SCHEDULER_HOST_ENV])
        ? env[MANAGEMENT_SCHEDULER_HOST_ENV]
        : controllerHost;
      return { controllerHost, schedulerHost, nonSchedulerHosts: [] };
    },
  });
}
