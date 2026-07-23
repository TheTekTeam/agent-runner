import { readSecretValueForEnvironment, SECRET_STATUS } from './agent-runner-secret-store.mjs';
import { parseSecretReference } from './agent-runner-secret-reference.mjs';

/**
 * Adapter-specific allowlisted environment materialization (issue #45).
 *
 * `entries` is an explicit, minimum-necessary allowlist: each item names
 * the child-process env var and the opaque secret reference that fills it.
 * There is no wildcard and no "give me everything configured for this
 * agent" mode — an adapter that needs three secrets lists exactly three
 * entries.
 *
 * `baseEnv` has no default value on purpose: the caller must decide the
 * base environment explicitly. This function never reads or spreads
 * `process.env` itself, so a value an operator happens to have exported in
 * their shell can never leak into a child process through this path
 * (the "process-environment inheritance" fail-closed requirement). An
 * adapter that wants PATH/HOME/etc. must pass them in `baseEnv` itself.
 *
 * An adapter with an empty `entries` list gets `baseEnv` back unchanged —
 * this is how Codex CLI's existing authenticated session stays untouched:
 * it is never forced through a secret-store/API-key design, it simply
 * requests zero entries and this function does nothing to its environment.
 */
export function materializeSecretEnvironment({
  dir,
  entries = [],
  baseEnv,
  optionalEnvVars = [],
  deps = {},
} = {}) {
  if (typeof baseEnv !== 'object' || baseEnv === null || Array.isArray(baseEnv)) {
    const error = new Error('materializeSecretEnvironment requires an explicit baseEnv object (never process.env by default)');
    error.code = 'AGENT_RUNNER_SECRET_ENV_BASE_REQUIRED';
    throw error;
  }
  if (!dir) {
    const error = new Error('materializeSecretEnvironment requires a secret store dir');
    error.code = 'AGENT_RUNNER_SECRET_ENV_DIR_REQUIRED';
    throw error;
  }

  const optional = new Set(optionalEnvVars);
  const env = { ...baseEnv };
  const missing = [];

  for (const entry of entries) {
    const envVar = entry?.envVar;
    const reference = entry?.reference;
    if (!envVar || typeof envVar !== 'string') {
      missing.push({ envVar: envVar || null, reason: 'missing-env-var-name' });
      continue;
    }
    const parsed = parseSecretReference(reference);
    if (!parsed.ok) {
      missing.push({ envVar, reason: `invalid-reference:${parsed.reason}` });
      continue;
    }
    const secret = readSecretValueForEnvironment(dir, parsed.id, deps);
    if (!secret.ok) {
      missing.push({ envVar, reason: `secret-${secret.status}` });
      continue;
    }
    env[envVar] = secret.value;
  }

  const required = missing.filter((entry) => !optional.has(entry.envVar));
  if (required.length > 0) {
    return { ok: false, env: null, missing, reason: 'required-secret-unavailable' };
  }
  return { ok: true, env, missing, reason: null };
}

export { SECRET_STATUS };
