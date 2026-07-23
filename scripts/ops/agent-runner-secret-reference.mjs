import { validateSecretId } from './agent-runner-secret-store.mjs';

/**
 * Opaque secret references (issue #45): the only form a secret is allowed
 * to take once it leaves the protected store and enters non-secret
 * settings (agent-settings.json, config files, GitHub comments, dashboard
 * payloads). A reference carries an id, never a value — the id is only
 * useful to look up the real secret through
 * `agent-runner-secret-environment.mjs`, and that lookup only ever ends up
 * in a child process env.
 */

const REFERENCE_PREFIX = 'secretref:';
const REFERENCE_PATTERN = /^secretref:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function buildSecretReference(id) {
  const check = validateSecretId(id);
  if (!check.ok) {
    const error = new Error(`cannot build a secret reference for an invalid id (${check.reason}): ${JSON.stringify(id)}`);
    error.code = 'AGENT_RUNNER_SECRET_INVALID_ID';
    throw error;
  }
  return `${REFERENCE_PREFIX}${id}`;
}

/**
 * Fail closed on anything that is not exactly `secretref:<id>`: absolute
 * paths, malformed ids, embedded whitespace/newlines, extra colons, and
 * anything longer than the id pattern allows. There is no partial-parse
 * fallback — a reference either matches exactly or it is rejected whole.
 */
export function parseSecretReference(reference) {
  if (typeof reference !== 'string') return { ok: false, id: null, reason: 'not-a-string' };
  if (!REFERENCE_PATTERN.test(reference)) return { ok: false, id: null, reason: 'malformed' };
  const id = reference.slice(REFERENCE_PREFIX.length);
  const idCheck = validateSecretId(id);
  if (!idCheck.ok) return { ok: false, id: null, reason: idCheck.reason };
  return { ok: true, id, reason: null };
}

export function isOpaqueSecretReference(value) {
  return parseSecretReference(value).ok;
}
