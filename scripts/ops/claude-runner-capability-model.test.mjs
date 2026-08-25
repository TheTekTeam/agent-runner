import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AVAILABLE_CAPABILITY_IDS,
  CAPABILITY_BOUNDED_BENCHMARK_RUN,
  CAPABILITY_DEPENDENCY_ANCESTRY_READ,
  CAPABILITY_DEPENDENCY_AUDIT_READ,
  CAPABILITY_HOST_FINGERPRINT_READ,
  CAPABILITY_PACKAGE_INSTALL_FROZEN,
  CAPABILITY_PACKAGE_RESOLUTION_UPDATE,
  CAPABILITY_REPO_VALIDATION,
  REQUIRED_CAPABILITY_IDS,
  UNAVAILABLE_CAPABILITY_IDS,
  evaluateCapabilityCompatibility,
  extendImplementationToolPolicyForCapabilities,
  normalizeRequiredCapabilities,
} from './claude-runner-capability-model.mjs';

const BASE_POLICY = Object.freeze({
  tools: 'Read,Glob,Grep,Edit,Write,Bash',
  allowedTools: Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git status)']),
  disallowedTools: Object.freeze(['Agent', 'Bash(git push *)', 'Bash(gh *)', 'Bash(curl *)', 'Bash(wget *)', 'Bash(sudo *)']),
});
const REVIEWED_REGISTRY = 'https://registry.npmjs.org/';

function addedRules(policy) {
  return policy.allowedTools.filter((rule) => !BASE_POLICY.allowedTools.includes(rule));
}

test('the exact incident-driven capability vocabulary is present', () => {
  assert.deepEqual([...REQUIRED_CAPABILITY_IDS], [
    CAPABILITY_BOUNDED_BENCHMARK_RUN,
    CAPABILITY_DEPENDENCY_ANCESTRY_READ,
    CAPABILITY_DEPENDENCY_AUDIT_READ,
    CAPABILITY_HOST_FINGERPRINT_READ,
    CAPABILITY_PACKAGE_INSTALL_FROZEN,
    CAPABILITY_PACKAGE_RESOLUTION_UPDATE,
    CAPABILITY_REPO_VALIDATION,
  ].sort());
  assert.deepEqual([...UNAVAILABLE_CAPABILITY_IDS], [CAPABILITY_BOUNDED_BENCHMARK_RUN]);
  assert.equal(AVAILABLE_CAPABILITY_IDS.includes(CAPABILITY_BOUNDED_BENCHMARK_RUN), false);
});

test('normalization dedupes deterministically and fails closed on unknown identifiers', () => {
  const deduped = normalizeRequiredCapabilities([
    CAPABILITY_DEPENDENCY_AUDIT_READ,
    CAPABILITY_DEPENDENCY_AUDIT_READ,
    CAPABILITY_HOST_FINGERPRINT_READ,
  ]);
  assert.equal(deduped.valid, true);
  assert.deepEqual([...deduped.capabilities], [CAPABILITY_DEPENDENCY_AUDIT_READ, CAPABILITY_HOST_FINGERPRINT_READ].sort());

  const unknown = normalizeRequiredCapabilities(['dependency-audit-read', 'network-unrestricted']);
  assert.equal(unknown.valid, false);
  assert.deepEqual([...unknown.unknown], ['network-unrestricted']);

  assert.deepEqual(normalizeRequiredCapabilities().capabilities, []);
  assert.deepEqual(normalizeRequiredCapabilities([' ', '']).capabilities, []);
});

test('no declared extra capabilities keeps the baseline tool policy unchanged and compatible', () => {
  const extended = extendImplementationToolPolicyForCapabilities(BASE_POLICY, []);
  assert.deepEqual([...extended.allowedTools], [...BASE_POLICY.allowedTools]);
  assert.deepEqual([...extended.disallowedTools], [...BASE_POLICY.disallowedTools]);
  assert.deepEqual([...extended.grantedCapabilities], []);
  assert.deepEqual([...extended.unavailableCapabilities], []);
});

test('dependency-audit-read grants only exact pnpm read-only audit forms pinned to the reviewed registry', () => {
  const auditOnly = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [CAPABILITY_DEPENDENCY_AUDIT_READ]);
  assert.deepEqual(addedRules(auditOnly), [
    `Bash(pnpm audit --registry=${REVIEWED_REGISTRY} --json)`,
    `Bash(pnpm audit --registry=${REVIEWED_REGISTRY} --audit-level=low --json)`,
    `Bash(pnpm audit --registry=${REVIEWED_REGISTRY} --audit-level=moderate --json)`,
    `Bash(pnpm audit --registry=${REVIEWED_REGISTRY} --audit-level=high --json)`,
    `Bash(pnpm audit --registry=${REVIEWED_REGISTRY} --audit-level=critical --json)`,
  ]);
  assert.ok(addedRules(auditOnly).every((rule) => !rule.includes('*')));
  assert.ok(addedRules(auditOnly).every((rule) => !/--fix|install|update|add/i.test(rule)));
  assert.ok(addedRules(auditOnly).every((rule) => rule.includes(`--registry=${REVIEWED_REGISTRY}`)));
});

test('unknown capability fails closed when extending a tool policy', () => {
  assert.throws(
    () => extendImplementationToolPolicyForCapabilities(BASE_POLICY, ['not-a-real-capability']),
    /Unknown implementation capability/,
  );
});

test('dependency read capabilities cannot install, update, fix, or widen shell syntax', () => {
  const readOnly = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [
    CAPABILITY_DEPENDENCY_AUDIT_READ,
    CAPABILITY_DEPENDENCY_ANCESTRY_READ,
  ]);
  const added = addedRules(readOnly);
  assert.ok(added.includes('Bash(pnpm list --depth Infinity --json)'));
  assert.ok(added.every((rule) => !/pnpm (?:install|update|add)|--fix|Bash\(npm /i.test(rule)));
  assert.ok(added.every((rule) => !/[;|&`$<>]/.test(rule)));
  assert.ok(added.every((rule) => !rule.includes('*')));
});

test('frozen install is exact, registry-pinned, script-suppressed, and cannot repair resolution', () => {
  const frozen = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [CAPABILITY_PACKAGE_INSTALL_FROZEN]);
  assert.deepEqual(addedRules(frozen), [
    `Bash(pnpm install --registry=${REVIEWED_REGISTRY} --frozen-lockfile --ignore-scripts)`,
  ]);
  assert.ok(addedRules(frozen).every((rule) => !/update|add|lockfile-only|--filter|\*/i.test(rule)));
});

test('package-resolution update is a separate exact registry-pinned lockfile-only operation', () => {
  const update = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [CAPABILITY_PACKAGE_RESOLUTION_UPDATE]);
  assert.deepEqual(addedRules(update), [
    `Bash(pnpm install --registry=${REVIEWED_REGISTRY} --lockfile-only --ignore-scripts)`,
  ]);
  assert.ok(addedRules(update).every((rule) => !/pnpm update|pnpm add|--filter|\*/i.test(rule)));
  assert.ok(addedRules(update).every((rule) => !/[;|&`$<>]/.test(rule)));
});

test('host fingerprint capability stays on exact bounded read-only commands', () => {
  const host = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [CAPABILITY_HOST_FINGERPRINT_READ]);
  const added = addedRules(host);
  assert.deepEqual(added, [
    'Bash(uname -m)',
    'Bash(uname -r)',
    'Bash(nproc)',
    'Bash(node --version)',
    'Bash(pnpm --version)',
    'Bash(lscpu)',
    'Bash(free -b)',
  ]);
  const forbidden = /env|printenv|\/proc|ip |ss |netstat|gh |curl|wget|sudo|systemctl|systemd|timer|git push|rm |mount|umount|\/prod/i;
  assert.ok(added.every((rule) => !forbidden.test(rule)));
  assert.ok(added.every((rule) => !rule.includes('*')));
});

test('bounded benchmark capability fails closed until a reviewed fixed harness exists', () => {
  assert.throws(
    () => extendImplementationToolPolicyForCapabilities(BASE_POLICY, [CAPABILITY_BOUNDED_BENCHMARK_RUN]),
    /requires reviewed harness: bounded-benchmark-run/,
  );

  const compatibility = evaluateCapabilityCompatibility({
    requiredCapabilities: [CAPABILITY_BOUNDED_BENCHMARK_RUN],
    grantedCapabilities: [CAPABILITY_BOUNDED_BENCHMARK_RUN],
  });
  assert.equal(compatibility.compatible, false);
  assert.equal(compatibility.reason, 'required-capability-unavailable');
  assert.deepEqual([...compatibility.missingCapabilities], [CAPABILITY_BOUNDED_BENCHMARK_RUN]);
  assert.deepEqual([...compatibility.unavailableCapabilities], [CAPABILITY_BOUNDED_BENCHMARK_RUN]);
  assert.deepEqual([...compatibility.grantedCapabilities], []);
});

test('multiple capabilities compose deterministically without duplicate or capability-added wildcards', () => {
  const composedA = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [
    CAPABILITY_DEPENDENCY_AUDIT_READ,
    CAPABILITY_HOST_FINGERPRINT_READ,
  ]);
  const composedB = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [
    CAPABILITY_HOST_FINGERPRINT_READ,
    CAPABILITY_DEPENDENCY_AUDIT_READ,
    CAPABILITY_DEPENDENCY_AUDIT_READ,
  ]);
  assert.deepEqual([...composedA.allowedTools], [...composedB.allowedTools]);
  assert.equal(new Set(composedA.allowedTools).size, composedA.allowedTools.length);
  assert.ok(addedRules(composedA).every((rule) => !rule.includes('*')));
  assert.deepEqual([...composedA.disallowedTools], [...BASE_POLICY.disallowedTools]);
});

test('evaluateCapabilityCompatibility reports missing capabilities and a bounded reason', () => {
  const result = evaluateCapabilityCompatibility({
    requiredCapabilities: [CAPABILITY_DEPENDENCY_AUDIT_READ, CAPABILITY_HOST_FINGERPRINT_READ],
    grantedCapabilities: [CAPABILITY_DEPENDENCY_AUDIT_READ],
  });
  assert.equal(result.compatible, false);
  assert.deepEqual([...result.missingCapabilities], [CAPABILITY_HOST_FINGERPRINT_READ]);
  assert.deepEqual([...result.unavailableCapabilities], []);
  assert.equal(result.reason, 'missing-required-capability');

  const compatible = evaluateCapabilityCompatibility({
    requiredCapabilities: [CAPABILITY_DEPENDENCY_AUDIT_READ],
    grantedCapabilities: [CAPABILITY_DEPENDENCY_AUDIT_READ, CAPABILITY_HOST_FINGERPRINT_READ],
  });
  assert.equal(compatible.compatible, true);
  assert.equal(compatible.reason, null);
});

test('evaluateCapabilityCompatibility fails closed on unknown required or granted capabilities', () => {
  const unknownRequired = evaluateCapabilityCompatibility({ requiredCapabilities: ['bogus'] });
  assert.equal(unknownRequired.compatible, false);
  assert.equal(unknownRequired.reason, 'unknown-required-capability');

  const unknownGranted = evaluateCapabilityCompatibility({
    requiredCapabilities: [CAPABILITY_DEPENDENCY_AUDIT_READ],
    grantedCapabilities: ['bogus'],
  });
  assert.equal(unknownGranted.compatible, false);
  assert.equal(unknownGranted.reason, 'unknown-granted-capability');
});

test('evaluateCapabilityCompatibility is pure with no required capabilities', () => {
  const result = evaluateCapabilityCompatibility({});
  assert.deepEqual([...result.requiredCapabilities], []);
  assert.deepEqual([...result.missingCapabilities], []);
  assert.deepEqual([...result.unavailableCapabilities], []);
  assert.equal(result.compatible, true);
  assert.equal(result.reason, null);
});
