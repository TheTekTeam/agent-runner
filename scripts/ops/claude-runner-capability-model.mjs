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

const REVIEWED_NPM_REGISTRY = 'https://registry.npmjs.org/';

/**
 * Capability mappings are positive allowlists only. Dynamic package-manager
 * command wildcards are deliberately prohibited because the permission rule
 * itself must not be able to select arbitrary packages, registries, mutation
 * flags or shell syntax. Network-capable pnpm operations pin the reviewed
 * public registry rather than inheriting repository/user registry overrides.
 *
 * `bounded-benchmark-run` remains a known vocabulary item but is intentionally
 * unavailable until a reviewed fixed benchmark harness exists. Treating that
 * capability as missing is safer than granting a mutable package-script
 * wildcard merely to make admission pass.
 */
const CAPABILITY_TOOL_RULES = Object.freeze({
  [CAPABILITY_DEPENDENCY_AUDIT_READ]: Object.freeze({
    available: true,
    allowedTools: Object.freeze([
      `Bash(pnpm audit --registry=${REVIEWED_NPM_REGISTRY} --json)`,
      `Bash(pnpm audit --registry=${REVIEWED_NPM_REGISTRY} --audit-level=low --json)`,
      `Bash(pnpm audit --registry=${REVIEWED_NPM_REGISTRY} --audit-level=moderate --json)`,
      `Bash(pnpm audit --registry=${REVIEWED_NPM_REGISTRY} --audit-level=high --json)`,
      `Bash(pnpm audit --registry=${REVIEWED_NPM_REGISTRY} --audit-level=critical --json)`,
    ]),
  }),
  [CAPABILITY_DEPENDENCY_ANCESTRY_READ]: Object.freeze({
    available: true,
    allowedTools: Object.freeze([
      'Bash(pnpm list --depth Infinity --json)',
    ]),
  }),
  [CAPABILITY_PACKAGE_INSTALL_FROZEN]: Object.freeze({
    available: true,
    allowedTools: Object.freeze([
      `Bash(pnpm install --registry=${REVIEWED_NPM_REGISTRY} --frozen-lockfile --ignore-scripts)`,
    ]),
  }),
  [CAPABILITY_PACKAGE_RESOLUTION_UPDATE]: Object.freeze({
    available: true,
    allowedTools: Object.freeze([
      `Bash(pnpm install --registry=${REVIEWED_NPM_REGISTRY} --lockfile-only --ignore-scripts)`,
    ]),
  }),
  // Ordinary repository editing/validation is already part of the baseline
  // policy, so this capability is a documented no-op: declaring it never
  // grants anything beyond baseline, and omitting it never removes baseline.
  [CAPABILITY_REPO_VALIDATION]: Object.freeze({
    available: true,
    allowedTools: Object.freeze([]),
  }),
  [CAPABILITY_HOST_FINGERPRINT_READ]: Object.freeze({
    available: true,
    allowedTools: Object.freeze([
      'Bash(uname -m)',
      'Bash(uname -r)',
      'Bash(nproc)',
      'Bash(node --version)',
      'Bash(pnpm --version)',
      'Bash(lscpu)',
      'Bash(free -b)',
    ]),
  }),
  [CAPABILITY_BOUNDED_BENCHMARK_RUN]: Object.freeze({
    available: false,
    unavailableReason: 'bounded-benchmark-harness-required',
    allowedTools: Object.freeze([]),
  }),
});

export const REQUIRED_CAPABILITY_IDS = Object.freeze(Object.keys(CAPABILITY_TOOL_RULES).sort());
export const AVAILABLE_CAPABILITY_IDS = Object.freeze(
  REQUIRED_CAPABILITY_IDS.filter((capability) => CAPABILITY_TOOL_RULES[capability].available),
);
export const UNAVAILABLE_CAPABILITY_IDS = Object.freeze(
  REQUIRED_CAPABILITY_IDS.filter((capability) => !CAPABILITY_TOOL_RULES[capability].available),
);

const KNOWN_CAPABILITY_SET = new Set(REQUIRED_CAPABILITY_IDS);
const AVAILABLE_CAPABILITY_SET = new Set(AVAILABLE_CAPABILITY_IDS);

/**
 * Parse/normalize a raw capability identifier list. Duplicates normalize
 * deterministically; any unknown/ambiguous identifier fails the whole list
 * closed rather than being silently dropped.
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

function unavailableCapabilities(capabilities = []) {
  return capabilities.filter((capability) => !AVAILABLE_CAPABILITY_SET.has(capability));
}

/**
 * Extend an existing (already narrow) implementation tool policy with the
 * reviewed rule set for each granted capability. Unknown capabilities and
 * known capabilities whose safe harness is not yet available both fail
 * closed before a provider can receive a tool policy.
 */
export function extendImplementationToolPolicyForCapabilities(basePolicy, capabilities = []) {
  if (!basePolicy || typeof basePolicy !== 'object') {
    throw new Error('A base implementation tool policy is required to extend it with capabilities');
  }
  const normalized = normalizeRequiredCapabilities(capabilities);
  if (!normalized.valid) {
    throw new Error(`Unknown implementation capability identifier(s): ${normalized.unknown.join(', ')}`);
  }

  const unavailable = unavailableCapabilities(normalized.capabilities);
  if (unavailable.length > 0) {
    throw new Error(`Implementation capability requires reviewed harness: ${unavailable.join(', ')}`);
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
    unavailableCapabilities: Object.freeze([]),
    allowedToolRuleCount: allowedTools.length,
    disallowedToolRuleCount: disallowedTools.length,
  };
}

/**
 * Pure compatibility evaluator for the follow-on admission slice (#229).
 * A known-but-unavailable capability is always treated as missing even if a
 * caller tries to claim it as granted. This prevents manager evidence from
 * bypassing the absence of a reviewed safe tool/harness mapping.
 */
export function evaluateCapabilityCompatibility({ requiredCapabilities = [], grantedCapabilities = [] } = {}) {
  const required = normalizeRequiredCapabilities(requiredCapabilities);
  if (!required.valid) {
    return {
      compatible: false,
      requiredCapabilities: required.capabilities,
      grantedCapabilities: Object.freeze([]),
      missingCapabilities: Object.freeze([]),
      unavailableCapabilities: Object.freeze([]),
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
      unavailableCapabilities: Object.freeze([]),
      reason: 'unknown-granted-capability',
      unknownCapabilities: granted.unknown,
    };
  }

  const unavailable = unavailableCapabilities(required.capabilities);
  const effectiveGranted = granted.capabilities.filter((capability) => AVAILABLE_CAPABILITY_SET.has(capability));
  const grantedSet = new Set(effectiveGranted);
  const missing = required.capabilities.filter((capability) => !grantedSet.has(capability));

  return {
    compatible: missing.length === 0,
    requiredCapabilities: required.capabilities,
    grantedCapabilities: Object.freeze(effectiveGranted),
    missingCapabilities: Object.freeze(missing),
    unavailableCapabilities: Object.freeze(unavailable),
    reason: missing.length === 0
      ? null
      : (unavailable.length > 0 ? 'required-capability-unavailable' : 'missing-required-capability'),
    unknownCapabilities: Object.freeze([]),
  };
}
