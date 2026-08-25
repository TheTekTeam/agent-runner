/**
 * Structured required-implementation-capability vocabulary and deterministic
 * Claude tool-policy mapping (#228).
 *
 * This module is intentionally pure: it never launches a provider, mutates
 * runner/GitHub state, or infers capabilities from free-form issue prose.
 * Only exact allowlisted capability identifiers coming from a structured
 * manager-preflight field are accepted; anything else fails closed.
 */

export const CAPABILITY_DEPENDENCY_AUDIT_READ = 'dependency-audit-read';
export const CAPABILITY_DEPENDENCY_ANCESTRY_READ = 'dependency-ancestry-read';
export const CAPABILITY_PACKAGE_INSTALL_FROZEN = 'package-install-frozen';
export const CAPABILITY_PACKAGE_RESOLUTION_UPDATE = 'package-resolution-update';
export const CAPABILITY_REPO_VALIDATION = 'repo-validation';
export const CAPABILITY_HOST_FINGERPRINT_READ = 'host-fingerprint-read';
export const CAPABILITY_BOUNDED_BENCHMARK_RUN = 'bounded-benchmark-run';

/**
 * Each capability maps to a narrow, reviewed set of additional Claude tool
 * rules. Read/ancestry/frozen-install/resolution-update capabilities are
 * kept deliberately distinct: none of them implicitly grants any other
 * capability's authority, and none grants network, `gh`, or host-mutation
 * access.
 */
const CAPABILITY_TOOL_RULES = Object.freeze({
  [CAPABILITY_DEPENDENCY_AUDIT_READ]: Object.freeze({
    allowedTools: Object.freeze([
      'Bash(npm audit)',
      'Bash(npm audit *)',
      'Bash(npm outdated)',
      'Bash(npm outdated *)',
    ]),
  }),
  [CAPABILITY_DEPENDENCY_ANCESTRY_READ]: Object.freeze({
    allowedTools: Object.freeze([
      'Bash(npm ls)',
      'Bash(npm ls *)',
      'Bash(npm why *)',
    ]),
  }),
  [CAPABILITY_PACKAGE_INSTALL_FROZEN]: Object.freeze({
    allowedTools: Object.freeze([
      'Bash(npm ci)',
      'Bash(npm ci *)',
    ]),
  }),
  [CAPABILITY_PACKAGE_RESOLUTION_UPDATE]: Object.freeze({
    allowedTools: Object.freeze([
      'Bash(npm install *)',
      'Bash(npm update *)',
    ]),
  }),
  // Ordinary repository editing/validation is already part of the baseline
  // policy, so this capability is a documented no-op: declaring it never
  // grants anything beyond baseline, and omitting it never removes baseline.
  [CAPABILITY_REPO_VALIDATION]: Object.freeze({
    allowedTools: Object.freeze([]),
  }),
  [CAPABILITY_HOST_FINGERPRINT_READ]: Object.freeze({
    allowedTools: Object.freeze([
      'Bash(uname -a)',
      'Bash(uname -m)',
      'Bash(uname -r)',
      'Bash(nproc)',
      'Bash(lscpu)',
    ]),
  }),
  // No committed benchmark harness exists yet; this narrowly pre-authorises
  // only `npm run bench`/`npm run bench:*` script invocations rather than
  // any raw command grammar, per #228's harness-preference requirement.
  [CAPABILITY_BOUNDED_BENCHMARK_RUN]: Object.freeze({
    allowedTools: Object.freeze([
      'Bash(npm run bench)',
      'Bash(npm run bench:*)',
    ]),
  }),
});

export const REQUIRED_CAPABILITY_IDS = Object.freeze(Object.keys(CAPABILITY_TOOL_RULES).sort());
const KNOWN_CAPABILITY_SET = new Set(REQUIRED_CAPABILITY_IDS);

/**
 * Parse/normalize a raw capability identifier list. Duplicates normalize
 * deterministically (case-insensitive dedupe, sorted output); any
 * unknown/ambiguous identifier fails the whole list closed rather than
 * silently dropping it.
 */
export function normalizeRequiredCapabilities(rawCapabilities = []) {
  const source = Array.isArray(rawCapabilities) ? rawCapabilities : [];
  const seen = new Set();
  const unknown = [];
  for (const entry of source) {
    const id = String(entry ?? '').trim();
    if (!id) continue;
    if (!KNOWN_CAPABILITY_SET.has(id)) {
      unknown.push(id);
      continue;
    }
    seen.add(id);
  }
  const capabilities = [...seen].sort();
  return {
    valid: unknown.length === 0,
    capabilities: Object.freeze(capabilities),
    unknown: Object.freeze(unknown),
  };
}

function dedupePreserveOrder(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Extend an existing (already narrow) implementation tool policy with the
 * reviewed rule set for each granted capability. Unknown capabilities are
 * never accepted here -- callers must normalize with
 * `normalizeRequiredCapabilities` first, which fails closed.
 */
export function extendImplementationToolPolicyForCapabilities(basePolicy, capabilities = []) {
  if (!basePolicy || typeof basePolicy !== 'object') {
    throw new Error('A base implementation tool policy is required to extend it with capabilities');
  }
  const normalized = normalizeRequiredCapabilities(capabilities);
  if (!normalized.valid) {
    throw new Error(`Unknown implementation capability identifier(s): ${normalized.unknown.join(', ')}`);
  }

  const addedAllowedTools = normalized.capabilities
    .flatMap((capability) => CAPABILITY_TOOL_RULES[capability].allowedTools);
  const allowedTools = dedupePreserveOrder([...basePolicy.allowedTools, ...addedAllowedTools]);
  const disallowedTools = [...basePolicy.disallowedTools];

  return {
    ...basePolicy,
    allowedTools,
    disallowedTools,
    grantedCapabilities: normalized.capabilities,
    allowedToolRuleCount: allowedTools.length,
    disallowedToolRuleCount: disallowedTools.length,
  };
}

/**
 * One pure compatibility evaluator/result for the follow-on admission slice
 * (#205): required capabilities, granted capabilities, missing capabilities,
 * and a bounded reason. This never launches a model or mutates
 * runner/GitHub state.
 */
export function evaluateCapabilityCompatibility({ requiredCapabilities = [], grantedCapabilities = [] } = {}) {
  const required = normalizeRequiredCapabilities(requiredCapabilities);
  if (!required.valid) {
    return {
      compatible: false,
      requiredCapabilities: required.capabilities,
      grantedCapabilities: Object.freeze([]),
      missingCapabilities: Object.freeze([]),
      reason: 'unknown-required-capability',
      unknownCapabilities: required.unknown,
    };
  }

  const granted = normalizeRequiredCapabilities(grantedCapabilities);
  if (!granted.valid) {
    return {
      compatible: false,
      requiredCapabilities: required.capabilities,
      grantedCapabilities: Object.freeze([]),
      missingCapabilities: Object.freeze([]),
      reason: 'unknown-granted-capability',
      unknownCapabilities: granted.unknown,
    };
  }

  const grantedSet = new Set(granted.capabilities);
  const missing = required.capabilities.filter((capability) => !grantedSet.has(capability));

  return {
    compatible: missing.length === 0,
    requiredCapabilities: required.capabilities,
    grantedCapabilities: granted.capabilities,
    missingCapabilities: Object.freeze(missing),
    reason: missing.length === 0 ? null : 'missing-required-capability',
    unknownCapabilities: Object.freeze([]),
  };
}
