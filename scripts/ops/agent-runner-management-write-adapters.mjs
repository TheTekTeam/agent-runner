#!/usr/bin/env node

/**
 * #268: the bounded production **write** transport.
 *
 * This is deliberately a separate module from the read adapters, and it is
 * constructed only when the persisted control mode is `active`. The read
 * adapter surface stays read-only, so a shadow, fenced or disabled control
 * plane has no write surface in scope at all -- not a suppressed one.
 *
 * What this module is: transport. It performs the bounded GitHub side effect an
 * already-validated transition asked for, and nothing else.
 *
 * What it deliberately is not:
 *
 *  - It re-derives no decision. `#266` already owns the registered repository,
 *    the source-SHA check, mutation bounds, allowed labels, curation identity,
 *    ownership collisions, the deterministic issue body, the managed dependency
 *    block and the mutation-kind allowlist. `#267` already owns authority
 *    identity and the canonical packet. Neither is re-implemented here.
 *  - It reaches no arbitrary endpoint. Every request URL is checked against a
 *    narrow pattern *and* against the exact repository the caller declared.
 *  - It has no capability to close an issue, merge, deploy, activate source,
 *    change a timer or service, alter the project registry, or read an account
 *    balance. There is simply no method that does any of those.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';

import {
  QUEUE_DEPENDENCY_BLOCK_END,
  QUEUE_DEPENDENCY_BLOCK_START,
} from './agent-runner-manager-queue-mutation.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_WRITE_ADAPTERS_SCHEMA_VERSION = 'agent-runner-management-write-adapters/v1';

/** The same bounded child environment the accepted GitHub clients already use. */
const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_HOST',
  'GH_TOKEN', 'GITHUB_TOKEN', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
]);

const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const CREATE_ISSUE_ENDPOINT = /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues$/;
const ISSUE_ENDPOINT = /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/[1-9][0-9]*$/;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_BODY = 60_000;
const COMMENTS_PER_PAGE = 100;
/**
 * The bounded ceiling on comment discovery.
 *
 * Idempotent publication depends on being able to prove a packet is *absent*
 * before posting. A single unpaginated page cannot prove that: a packet sitting
 * beyond it would be invisible and the retry would post a duplicate. So the
 * whole comment set is walked, up to this ceiling -- and if the ceiling is
 * reached with a full final page, absence is unproven and the read fails closed
 * rather than licensing a duplicate.
 */
const MAX_COMMENT_PAGES = 20;

function fail(message, code = 'management-write-failed') {
  const error = new Error(`Agent Runner management write refusal: ${message}`);
  error.code = code;
  return error;
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

/**
 * Every endpoint must belong to the exact repository the caller declared. This
 * is what stops a transaction computed for one registered project from ever
 * touching another repository, even if an endpoint were mis-built upstream.
 */
function assertEndpointRepository(endpoint, repository, pattern) {
  if (!nonEmptyString(repository) || !REPOSITORY_PATTERN.test(repository)) {
    throw fail('a bounded "owner/name" repository is required');
  }
  if (typeof endpoint !== 'string' || !pattern.test(endpoint)) {
    throw fail('GitHub endpoint is not allowlisted');
  }
  if (!endpoint.startsWith(`/repos/${repository}/issues`)) {
    throw fail(`GitHub endpoint '${endpoint}' does not target the declared repository '${repository}'`);
  }
  return endpoint;
}

function classify(result) {
  const stderr = String(result?.stderr || '').toLowerCase();
  if (result?.error?.code === 'ETIMEDOUT') return 'provider-timeout';
  if (stderr.includes('rate limit') || stderr.includes('secondary rate')) return 'provider-rate-limited';
  if (result?.status === 4 || stderr.includes('authentication')) return 'provider-auth-failed';
  if (result?.status === 403 || stderr.includes('permission')) return 'provider-write-forbidden';
  return 'provider-write-failed';
}

/**
 * Build the production write transport.
 *
 * `spawn` is injected, so the focused tests drive this exact code with a bounded
 * fake process runner rather than a parallel implementation.
 */
export function createDellManagementWriteAdapters({
  spawn = defaultSpawnSync,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof spawn !== 'function') throw fail('a spawn function is required');
  const childEnv = childEnvironment(env);
  const bounded = Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 5 * 60_000
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;

  function request(method, endpoint, payload = null) {
    const args = ['api', '--method', method, endpoint];
    if (payload !== null) args.push('--input', '-');
    const result = spawn('gh', args, {
      encoding: 'utf8',
      stdio: payload === null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      ...(payload === null ? {} : { input: JSON.stringify(payload) }),
      env: childEnv,
      timeout: bounded,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (!result || result.error || result.status !== 0) {
      throw fail(`${method} ${endpoint} failed`, classify(result));
    }
    try {
      return JSON.parse(result.stdout || 'null');
    } catch {
      throw fail('GitHub returned invalid JSON', 'provider-invalid-json');
    }
  }

  function readIssueBody(repository, issueNumber) {
    const endpoint = assertEndpointRepository(`/repos/${repository}/issues/${issueNumber}`, repository, ISSUE_ENDPOINT);
    const issue = request('GET', endpoint);
    if (!isPlainObject(issue) || typeof issue.body !== 'string') {
      throw fail(`issue #${issueNumber} body could not be read`, 'provider-read-failed');
    }
    return issue.body;
  }

  /**
   * Replace exactly the delimited managed dependency block, preserving every
   * other byte of the issue body.
   *
   * Human-authored text around the markers is never touched, and an absent,
   * duplicated or inverted marker pair fails closed rather than guessing where
   * the managed region begins.
   */
  function replaceDependencyBlock(body, dependencyBlock) {
    const startCount = body.split(QUEUE_DEPENDENCY_BLOCK_START).length - 1;
    const endCount = body.split(QUEUE_DEPENDENCY_BLOCK_END).length - 1;
    if (startCount === 0 && endCount === 0) {
      // No managed region yet: append one rather than rewriting the body.
      return `${body.replace(/\s*$/, '')}\n\n${dependencyBlock}\n`;
    }
    if (startCount !== 1 || endCount !== 1) {
      throw fail('the managed dependency block markers are ambiguous', 'dependency-block-ambiguous');
    }
    const start = body.indexOf(QUEUE_DEPENDENCY_BLOCK_START);
    const end = body.indexOf(QUEUE_DEPENDENCY_BLOCK_END);
    if (end < start) throw fail('the managed dependency block markers are inverted', 'dependency-block-ambiguous');
    const before = body.slice(0, start);
    const after = body.slice(end + QUEUE_DEPENDENCY_BLOCK_END.length);
    return `${before}${dependencyBlock}${after}`;
  }

  return Object.freeze({
    /**
     * The `#266` client port, exactly as the accepted mutation boundary calls
     * it. Each method performs only the side effect the already-validated
     * transaction requested.
     */
    createQueueMutationClient({ repository }) {
      if (!nonEmptyString(repository) || !REPOSITORY_PATTERN.test(repository)) {
        throw fail('a bounded "owner/name" repository is required');
      }
      return Object.freeze({
        createIssue({ endpoint, title, body, labels }) {
          assertEndpointRepository(endpoint, repository, CREATE_ISSUE_ENDPOINT);
          if (!nonEmptyString(title) || !nonEmptyString(body)) throw fail('issue creation requires a validated title and body');
          if (body.length > MAX_BODY) throw fail('issue creation body exceeds the bounded size');
          const created = request('POST', endpoint, { title, body, labels: Array.isArray(labels) ? labels : [] });
          const number = isPlainObject(created) ? created.number : null;
          // #266 refuses an unverifiable creation, so an ambiguous response must
          // surface rather than being smoothed over here.
          if (!Number.isInteger(number) || number <= 0) {
            throw fail('GitHub returned no created issue number', 'queue-mutation-unverifiable');
          }
          return { number };
        },

        updateIssueLabels({ endpoint, labels }) {
          assertEndpointRepository(endpoint, repository, ISSUE_ENDPOINT);
          if (!Array.isArray(labels)) throw fail('label mutation requires the validated resulting label array');
          // The resulting set is authoritative: #266 already computed it.
          request('PATCH', endpoint, { labels });
          return { ok: true };
        },

        updateIssueDependencies({ endpoint, issueNumber, dependencyBlock }) {
          assertEndpointRepository(endpoint, repository, ISSUE_ENDPOINT);
          if (!nonEmptyString(dependencyBlock)) throw fail('dependency mutation requires the validated dependency block');
          const current = readIssueBody(repository, issueNumber);
          const next = replaceDependencyBlock(current, dependencyBlock);
          if (next.length > MAX_BODY) throw fail('the updated issue body exceeds the bounded size');
          if (next === current) return { ok: true, unchanged: true };
          request('PATCH', endpoint, { body: next });
          return { ok: true };
        },
      });
    },

    /**
     * The issue's comments, paginated to a bounded ceiling.
     *
     * Returns the whole set so publication can prove absence. Reaching the
     * ceiling with a still-full page means absence cannot be proven, which
     * throws rather than returning a partial set -- a partial set would look
     * exactly like "the packet is not there".
     */
    listIssueComments({ repository, issueNumber }) {
      const endpoint = assertEndpointRepository(
        `/repos/${repository}/issues/${issueNumber}`, repository, ISSUE_ENDPOINT,
      );
      const collected = [];
      for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
        const payload = request('GET', `${endpoint}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`);
        if (!Array.isArray(payload)) break;
        for (const comment of payload) {
          if (!isPlainObject(comment)) continue;
          collected.push({
            id: comment.id,
            body: typeof comment.body === 'string' ? comment.body : '',
            createdAt: comment.created_at ?? null,
            author: String(comment.user?.login ?? ''),
          });
        }
        // A short page is the last page, so the set is complete.
        if (payload.length < COMMENTS_PER_PAGE) return collected;
      }
      throw fail(
        `issue #${issueNumber} has more comments than the bounded discovery ceiling can prove`,
        'comment-set-unbounded',
      );
    },

    /** Post exactly one bounded comment on exactly one issue. */
    createIssueComment({ repository, issueNumber, body }) {
      const endpoint = assertEndpointRepository(
        `/repos/${repository}/issues/${issueNumber}`, repository, ISSUE_ENDPOINT,
      );
      if (!nonEmptyString(body) || body.length > MAX_BODY) throw fail('comment body is not bounded');
      const created = request('POST', `${endpoint}/comments`, { body });
      return { id: isPlainObject(created) ? created.id ?? null : null };
    },
  });
}
