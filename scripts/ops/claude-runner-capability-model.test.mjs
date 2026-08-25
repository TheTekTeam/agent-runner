import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITY_BOUNDED_BENCHMARK_RUN,
  CAPABILITY_DEPENDENCY_ANCESTRY_READ,
  CAPABILITY_DEPENDENCY_AUDIT_READ,
  CAPABILITY_HOST_FINGERPRINT_READ,
  CAPABILITY_PACKAGE_INSTALL_FROZEN,
  CAPABILITY_PACKAGE_RESOLUTION_UPDATE,
  CAPABILITY_REPO_VALIDATION,
  REQUIRED_CAPABILITY_IDS,
  evaluateCapabilityCompatibility,
  extendImplementationToolPolicyForCapabilities,
  normalizeRequiredCapabilities,
} from './claude-runner-capability-model.mjs';

const BASE_POLICY = Object.freeze({
  tools: 'Read,Glob,Grep,Edit,Write,Bash',
  allowedTools: Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git status)']),
  disallowedTools: Object.freeze(['Agent', 'Bash(git push *)', 'Bash(gh *)', 'Bash(curl *)', 'Bash(wget *)', 'Bash(sudo *)']),
});

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
});

test('each required capability adds only its reviewed intended rule set', () => {
  const auditOnly = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [CAPABILITY_DEPENDENCY_AUDIT_READ]);
  const added = auditOnly.allowedTools.filter((rule) => !BASE_POLICY.allowedTools.includes(rule));
  assert.deepEqual(added.sort(), ['Bash(npm audit *)', 'Bash(npm audit)', 'Bash(npm outdated *)', 'Bash(npm outdated)'].sort());
});

test('unknown capability fails closed when extending a tool policy', () => {
  assert.throws(
    () => extendImplementationToolPolicyForCapabilities(BASE_POLICY, ['not-a-real-capability']),
    /Unknown implementation capability/,
  );
});

test('dependency read capabilities cannot install or update packages', () => {
  const readOnly = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [
    CAPABILITY_DEPENDENCY_AUDIT_READ,
    CAPABILITY_DEPENDENCY_ANCESTRY_READ,
  ]);
  assert.ok(readOnly.allowedTools.every((rule) => !/npm ci|npm install|npm update/.test(rule)));
});

test('frozen install cannot imply arbitrary resolution update', () => {
  const frozen = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [CAPABILITY_PACKAGE_INSTALL_FROZEN]);
  assert.ok(frozen.allowedTools.some((rule) => /npm ci/.test(rule)));
  assert.ok(frozen.allowedTools.every((rule) => !/npm install|npm update/.test(rule)));
});

test('package-resolution update remains separately gated from frozen install', () => {
  const update = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [CAPABILITY_PACKAGE_RESOLUTION_UPDATE]);
  assert.ok(update.allowedTools.some((rule) => /npm install \*/.test(rule)));
  assert.ok(update.allowedTools.every((rule) => !/npm ci/.test(rule)));
});

test('host and benchmark capabilities cannot access network, gh, sudo, or destructive git', () => {
  const hostAndBench = extendImplementationToolPolicyForCapabilities(BASE_POLICY, [
    CAPABILITY_HOST_FINGERPRINT_READ,
    CAPABILITY_BOUNDED_BENCHMARK_RUN,
  ]);
  const forbidden = /gh |curl|wget|sudo|systemctl|systemd|timer|git push|rm -rf|\/prod/i;
  assert.ok(hostAndBench.allowedTools.every((rule) => !forbidden.test(rule)));
  assert.deepEqual([...hostAndBench.disallowedTools], [...BASE_POLICY.disallowedTools]);
});

test('multiple capabilities compose deterministically without duplicate or wildcard broadening', () => {
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
  assert.ok(composedA.allowedTools.every((rule) => rule !== '*' && rule !== 'Bash(*)'));
});

test('evaluateCapabilityCompatibility reports missing capabilities and a bounded reason', () => {
  const result = evaluateCapabilityCompatibility({
    requiredCapabilities: [CAPABILITY_DEPENDENCY_AUDIT_READ, CAPABILITY_HOST_FINGERPRINT_READ],
    grantedCapabilities: [CAPABILITY_DEPENDENCY_AUDIT_READ],
  });
  assert.equal(result.compatible, false);
  assert.deepEqual([...result.missingCapabilities], [CAPABILITY_HOST_FINGERPRINT_READ]);
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
  assert.equal(result.compatible, true);
  assert.equal(result.reason, null);
});
