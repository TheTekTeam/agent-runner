import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdmissionCircuitBreaker } from './agent-runner-circuit-breaker.mjs';
import {
  CandidateProfileCircuitBreaker,
  candidateBudgetIdentity,
  candidateEffectiveCostFingerprint,
  candidateEffectiveCostFingerprintMaterial,
  candidateProfileCircuitPausePayload,
} from './agent-runner-candidate-profile-circuit.mjs';

const FP_B = `sha256:${'b'.repeat(64)}`;
const FP_D = `sha256:${'d'.repeat(64)}`;

function authority({
  revision = 'AR235-2026-08-17.1',
  fingerprint = FP_B,
  packetDigest = `sha256:${'c'.repeat(64)}`,
} = {}) {
  return {
    authorityKey: `manager-preflight:${revision}:${fingerprint}`,
    revision,
    fingerprint,
    packetDigest,
  };
}

function fixture(overrides = {}) {
  return {
    machineConfigurationFingerprint: `sha256:${'a'.repeat(64)}`,
    managerAuthority: authority(),
    profile: {
      profile: 'narrow',
      model: 'sonnet',
      effort: 'low',
      maxBudgetUsd: 2.5,
    },
    managerMaxBudgetUsd: {
      present: true,
      valid: true,
      value: 2.5,
      raw: '2.50',
    },
    costAdmission: {
      policy: {
        maxBudgetUsd: 2,
        opusAllowed: false,
        highEffortAllowed: false,
      },
    },
    ...overrides,
  };
}

function withCandidateBreaker(run) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-candidate-profile-circuit-'));
  const dbPath = join(dir, 'circuit.sqlite');
  const breaker = new CandidateProfileCircuitBreaker(dbPath, {
    now: () => '2026-08-17T20:00:00.000Z',
  });
  try {
    return run(breaker, dbPath);
  } finally {
    breaker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('quoted and unquoted equivalent valid manager budgets produce the same identity and fingerprint', () => {
  const quoted = fixture({
    managerMaxBudgetUsd: { present: true, valid: true, value: 1, raw: '"1.00"' },
    profile: { profile: 'narrow', model: 'sonnet', effort: 'low', maxBudgetUsd: 1 },
  });
  const unquoted = fixture({
    managerMaxBudgetUsd: { present: true, valid: true, value: 1.0, raw: '1.00' },
    profile: { profile: 'narrow', model: 'sonnet', effort: 'low', maxBudgetUsd: '1.00' },
  });
  assert.equal(candidateBudgetIdentity({ managerMaxBudgetUsd: quoted.managerMaxBudgetUsd }), 'manager-valid:1');
  assert.equal(candidateEffectiveCostFingerprint(quoted), candidateEffectiveCostFingerprint(unquoted));
});

test('malformed explicit budget has deterministic fail-closed identity distinct from absent/default budget', () => {
  const malformed = fixture({
    managerMaxBudgetUsd: { present: true, valid: false, value: null, raw: '2.00"' },
    profile: { profile: 'narrow', model: 'sonnet', effort: 'low', maxBudgetUsd: 'invalid-manager-max-budget-usd:2.00"' },
  });
  const sameMalformed = fixture({
    managerMaxBudgetUsd: { present: true, valid: false, value: null, raw: '2.00"' },
    profile: { profile: 'narrow', model: 'sonnet', effort: 'low', maxBudgetUsd: 'invalid-manager-max-budget-usd:2.00"' },
  });
  const absent = fixture({
    managerMaxBudgetUsd: { present: false, valid: false, value: null, raw: null },
    profile: { profile: 'narrow', model: 'sonnet', effort: 'low', maxBudgetUsd: 0.5 },
  });
  assert.match(candidateBudgetIdentity({ managerMaxBudgetUsd: malformed.managerMaxBudgetUsd }), /^manager-invalid:sha256:[0-9a-f]{64}$/);
  assert.equal(candidateEffectiveCostFingerprint(malformed), candidateEffectiveCostFingerprint(sameMalformed));
  assert.notEqual(candidateEffectiveCostFingerprint(malformed), candidateEffectiveCostFingerprint(absent));
});

test('relevant machine cost policy and manager authority changes alter candidate-effective fingerprint', () => {
  const baseline = candidateEffectiveCostFingerprint(fixture());
  const capChanged = candidateEffectiveCostFingerprint(fixture({
    costAdmission: { policy: { maxBudgetUsd: 3, opusAllowed: false, highEffortAllowed: false } },
  }));
  const opusChanged = candidateEffectiveCostFingerprint(fixture({
    costAdmission: { policy: { maxBudgetUsd: 2, opusAllowed: true, highEffortAllowed: false } },
  }));
  const effortPolicyChanged = candidateEffectiveCostFingerprint(fixture({
    costAdmission: { policy: { maxBudgetUsd: 2, opusAllowed: false, highEffortAllowed: true } },
  }));
  const authorityChanged = candidateEffectiveCostFingerprint(fixture({
    managerAuthority: authority({
      revision: 'AR235-2026-08-17.2',
      fingerprint: FP_D,
      packetDigest: `sha256:${'e'.repeat(64)}`,
    }),
  }));
  assert.notEqual(baseline, capChanged);
  assert.notEqual(baseline, opusChanged);
  assert.notEqual(baseline, effortPolicyChanged);
  assert.notEqual(baseline, authorityChanged);
});

test('fingerprint material fails closed when required authority/profile/machine-policy inputs are incomplete or inconsistent', () => {
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), machineConfigurationFingerprint: null }),
    /machineConfigurationFingerprint/,
  );
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), managerAuthority: { ...authority(), packetDigest: null } }),
    /packetDigest/,
  );
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), managerAuthority: { ...authority(), authorityKey: 'wrong' } }),
    /authorityKey does not match/,
  );
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), profile: { ...fixture().profile, model: null } }),
    /profile.model/,
  );
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), profile: { ...fixture().profile, maxBudgetUsd: null }, managerMaxBudgetUsd: null }),
    /budget identity/,
  );
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), costAdmission: { policy: { maxBudgetUsd: null, opusAllowed: false, highEffortAllowed: false } } }),
    /maxBudgetUsd/,
  );
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), costAdmission: { policy: { maxBudgetUsd: 2, opusAllowed: 'false', highEffortAllowed: false } } }),
    /opusAllowed/,
  );
});

test('fingerprint material is positive-allowlisted and irrelevant/raw fields do not alter identity', () => {
  const baseline = candidateEffectiveCostFingerprint(fixture());
  const enriched = {
    ...fixture(),
    policyRevision: 'caller-controlled-revision-must-be-ignored',
    managerAuthority: {
      ...fixture().managerAuthority,
      body: 'TOP SECRET PACKET BODY',
      token: 'secret-token',
      arbitraryComment: 'private comment',
    },
    profile: {
      ...fixture().profile,
      tools: ['Bash(*)'],
      path: '/home/gp/private',
      prompt: 'secret prompt',
    },
    costAdmission: {
      ...fixture().costAdmission,
      providerOutput: 'secret provider output',
      env: { SECRET: 'value' },
    },
    arbitraryEnv: { TOKEN: 'secret' },
  };
  const material = candidateEffectiveCostFingerprintMaterial(enriched);
  const serialized = JSON.stringify(material);
  for (const forbidden of ['TOP SECRET', 'secret-token', 'private comment', 'Bash(*)', '/home/gp/private', 'secret prompt', 'secret provider output', 'SECRET', 'TOKEN', 'caller-controlled-revision']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(candidateEffectiveCostFingerprint(enriched), baseline);
  assert.deepEqual(Object.keys(material).sort(), [
    'machineConfigurationFingerprint',
    'machineCostPolicy',
    'managerAuthority',
    'resolvedProfile',
    'schemaVersion',
  ]);
});

test('one candidate refusal trips immediately and identical refusal is blocked and deduped', () => withCandidateBreaker((breaker) => {
  const fingerprint = candidateEffectiveCostFingerprint(fixture());
  const first = breaker.record({
    effectiveFingerprint: fingerprint,
    reason: 'candidate-machine-profile-cost-denied',
  });
  assert.equal(first.tripped, true);
  assert.equal(first.newlyTripped, true);
  assert.equal(first.externalFailureScope, 'machine_profile');
  assert.equal(first.occurrenceCount, 1);

  const current = breaker.check({
    effectiveFingerprint: fingerprint,
    reason: 'candidate-machine-profile-cost-denied',
  });
  assert.equal(current.blocked, true);
  assert.equal(current.externalFailureScope, 'machine_profile');
  assert.match(current.safeNextAction, /fresh superseding immutable manager authority/);
  assert.match(current.safeNextAction, /do not edit the existing packet/);

  assert.equal(breaker.markNotificationEmitted(), true);
  assert.equal(breaker.markNotificationEmitted(), false);
  const second = breaker.record({
    effectiveFingerprint: fingerprint,
    reason: 'candidate-machine-profile-cost-denied',
  });
  assert.equal(second.newlyTripped, false);
  assert.equal(second.occurrenceCount, 2);
  const after = breaker.check({
    effectiveFingerprint: fingerprint,
    reason: 'candidate-machine-profile-cost-denied',
  });
  assert.equal(after.notificationEmitted, true);
}));

test('fresh candidate-effective configuration is stale-not-blocked and replaces old current incident only when recorded', () => withCandidateBreaker((breaker) => {
  const firstFingerprint = candidateEffectiveCostFingerprint(fixture());
  const nextFingerprint = candidateEffectiveCostFingerprint(fixture({
    managerAuthority: authority({
      revision: 'AR235-2026-08-17.2',
      fingerprint: FP_D,
      packetDigest: `sha256:${'e'.repeat(64)}`,
    }),
    managerMaxBudgetUsd: { present: true, valid: true, value: 1, raw: '1.00' },
    profile: { profile: 'narrow', model: 'sonnet', effort: 'low', maxBudgetUsd: 1 },
  }));
  breaker.record({ effectiveFingerprint: firstFingerprint, reason: 'candidate-machine-profile-cost-denied' });

  const checkFresh = breaker.check({
    effectiveFingerprint: nextFingerprint,
    reason: 'candidate-machine-profile-cost-denied',
  });
  assert.equal(checkFresh.blocked, false);
  assert.equal(checkFresh.stale, true);

  breaker.record({ effectiveFingerprint: nextFingerprint, reason: 'candidate-machine-profile-cost-denied' });
  const oldAfterReplacement = breaker.check({
    effectiveFingerprint: firstFingerprint,
    reason: 'candidate-machine-profile-cost-denied',
  });
  assert.equal(oldAfterReplacement.blocked, false);
  assert.equal(oldAfterReplacement.stale, true);
  assert.equal(breaker.check({ effectiveFingerprint: nextFingerprint, reason: 'candidate-machine-profile-cost-denied' }).blocked, true);
}));

test('candidate circuit remains independent from machine-global and systemic admission circuits in the same DB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-circuit-coexist-'));
  const dbPath = join(dir, 'circuit.sqlite');
  const globalBreaker = new AdmissionCircuitBreaker(dbPath, { now: () => '2026-08-17T20:00:00.000Z' });
  try {
    globalBreaker.record({
      scope: 'machine_profile',
      reason: 'implementation-machine-opt-in-disabled',
      configurationFingerprint: 'sha256:machine-a',
    });
    const candidateBreaker = new CandidateProfileCircuitBreaker(dbPath, { now: () => '2026-08-17T20:00:01.000Z' });
    try {
      const candidateFingerprint = candidateEffectiveCostFingerprint(fixture());
      candidateBreaker.record({
        effectiveFingerprint: candidateFingerprint,
        reason: 'candidate-machine-profile-cost-denied',
      });
      assert.equal(candidateBreaker.check({ effectiveFingerprint: candidateFingerprint, reason: 'candidate-machine-profile-cost-denied' }).blocked, true);
      assert.equal(globalBreaker.check({ configurationFingerprint: 'sha256:machine-a' }).blocked, true);
      assert.equal(globalBreaker.db.prepare('SELECT COUNT(*) AS count FROM admission_circuit').get().count, 1);
      assert.equal(candidateBreaker.db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_circuit').get().count, 1);
    } finally {
      candidateBreaker.close();
    }
  } finally {
    globalBreaker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repeated candidate refusal keeps one bounded current circuit row rather than appending history rows', () => withCandidateBreaker((breaker) => {
  const fingerprint = candidateEffectiveCostFingerprint(fixture());
  for (let i = 0; i < 25; i += 1) {
    breaker.record({ effectiveFingerprint: fingerprint, reason: 'candidate-machine-profile-cost-denied' });
  }
  assert.equal(breaker.db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_circuit').get().count, 1);
  const row = breaker.db.prepare('SELECT occurrence_count FROM candidate_profile_circuit').get();
  assert.equal(row.occurrence_count, 25);
}));

test('candidate circuit payload preserves external machine_profile scope and zero-side-effect evidence', () => {
  const fingerprint = candidateEffectiveCostFingerprint(fixture());
  const payload = candidateProfileCircuitPausePayload({
    reason: 'candidate-machine-profile-cost-denied',
    effectiveFingerprint: fingerprint,
    occurrenceCount: 3,
  });
  assert.equal(payload.circuitDomain, 'candidate_profile');
  assert.equal(payload.failureScope, 'machine_profile');
  assert.equal(payload.candidateEffectiveFingerprint, fingerprint);
  assert.equal(payload.attemptCreated, false);
  assert.equal(payload.childLaunched, false);
  assert.equal(payload.issueMutation, false);
  assert.equal(payload.systemdOutcome, 'handled');
  assert.match(payload.safeNextAction, /never edit an existing packet/i);
});
