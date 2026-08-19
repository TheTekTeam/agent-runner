import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CandidateProfileCircuitBreaker,
  candidateEffectiveCostFingerprint,
  candidateEffectiveCostFingerprintMaterial,
  candidateProfileCircuitPausePayload,
} from './agent-runner-candidate-profile-circuit.mjs';

const FP_B = `sha256:${'b'.repeat(64)}`;
const FP_D = `sha256:${'d'.repeat(64)}`;

function authority({
  revision = 'AR264-2026-08-19.1',
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
    },
    costAdmission: {
      policy: {
        opusAllowed: false,
        highEffortAllowed: false,
      },
    },
    ...overrides,
  };
}

function withBreaker(run) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-candidate-profile-circuit-'));
  const dbPath = join(dir, 'circuit.sqlite');
  const breaker = new CandidateProfileCircuitBreaker(dbPath, {
    now: () => '2026-08-19T20:00:00.000Z',
  });
  try {
    return run(breaker, dbPath);
  } finally {
    breaker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('candidate-effective fingerprint contains no dollar-budget identity or machine cap', () => {
  const material = candidateEffectiveCostFingerprintMaterial(fixture());
  const serialized = JSON.stringify(material);

  assert.equal(serialized.includes('maxBudgetUsd'), false);
  assert.equal(serialized.includes('budgetIdentity'), false);
  assert.equal(serialized.includes('max_budget_usd'), false);

  assert.deepEqual(material.resolvedProfile, {
    profile: 'narrow',
    model: 'sonnet',
    effort: 'low',
  });

  assert.deepEqual(material.machineCostPolicy, {
    opusAllowed: false,
    highEffortAllowed: false,
  });
});

test('model, effort-policy and immutable manager-authority changes alter the fingerprint', () => {
  const baseline = candidateEffectiveCostFingerprint(fixture());

  const modelChanged = candidateEffectiveCostFingerprint(fixture({
    profile: { profile: 'narrow', model: 'opus', effort: 'low' },
  }));

  const policyChanged = candidateEffectiveCostFingerprint(fixture({
    costAdmission: { policy: { opusAllowed: true, highEffortAllowed: false } },
  }));

  const authorityChanged = candidateEffectiveCostFingerprint(fixture({
    managerAuthority: authority({
      revision: 'AR264-2026-08-19.2',
      fingerprint: FP_D,
      packetDigest: `sha256:${'e'.repeat(64)}`,
    }),
  }));

  assert.notEqual(baseline, modelChanged);
  assert.notEqual(baseline, policyChanged);
  assert.notEqual(baseline, authorityChanged);
});

test('fingerprint material fails closed when required authority/profile/policy inputs are incomplete', () => {
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), machineConfigurationFingerprint: null }),
    /machineConfigurationFingerprint/,
  );
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), managerAuthority: { ...authority(), packetDigest: null } }),
    /packetDigest/,
  );
  assert.throws(
    () => candidateEffectiveCostFingerprint({ ...fixture(), profile: { ...fixture().profile, model: null } }),
    /profile.model/,
  );
  assert.throws(
    () => candidateEffectiveCostFingerprint({
      ...fixture(),
      costAdmission: { policy: { opusAllowed: 'false', highEffortAllowed: false } },
    }),
    /opusAllowed/,
  );
});

test('irrelevant raw fields cannot alter or leak into candidate-effective fingerprint material', () => {
  const baseline = candidateEffectiveCostFingerprint(fixture());

  const enriched = {
    ...fixture(),
    managerAuthority: {
      ...fixture().managerAuthority,
      body: 'TOP SECRET PACKET BODY',
      token: 'secret-token',
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
    },
  };

  const material = candidateEffectiveCostFingerprintMaterial(enriched);
  const serialized = JSON.stringify(material);

  for (const forbidden of [
    'TOP SECRET',
    'secret-token',
    'Bash(*)',
    '/home/gp/private',
    'secret prompt',
    'secret provider output',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  assert.equal(candidateEffectiveCostFingerprint(enriched), baseline);
});

test('one machine-profile refusal trips immediately and identical refusal is deduped', () => withBreaker((breaker) => {
  const fingerprint = candidateEffectiveCostFingerprint(fixture());

  const first = breaker.record({
    effectiveFingerprint: fingerprint,
    reason: 'candidate-machine-profile-cost-denied',
  });

  assert.equal(first.tripped, true);
  assert.equal(first.newlyTripped, true);
  assert.equal(first.occurrenceCount, 1);

  const current = breaker.check({
    effectiveFingerprint: fingerprint,
    reason: 'candidate-machine-profile-cost-denied',
  });

  assert.equal(current.blocked, true);
  assert.match(current.safeNextAction, /manager intent\/profile changes/);

  const second = breaker.record({
    effectiveFingerprint: fingerprint,
    reason: 'candidate-machine-profile-cost-denied',
  });

  assert.equal(second.newlyTripped, false);
  assert.equal(second.occurrenceCount, 2);
  assert.equal(
    breaker.db.prepare('SELECT COUNT(*) AS count FROM candidate_profile_circuit').get().count,
    1,
  );
}));

test('candidate circuit stays separate from execution side effects', () => {
  const fingerprint = candidateEffectiveCostFingerprint(fixture());
  const payload = candidateProfileCircuitPausePayload({
    reason: 'candidate-machine-profile-cost-denied',
    effectiveFingerprint: fingerprint,
    occurrenceCount: 3,
  });

  assert.equal(payload.failureScope, 'machine_profile');
  assert.equal(payload.candidateEffectiveFingerprint, fingerprint);
  assert.equal(payload.attemptCreated, false);
  assert.equal(payload.childLaunched, false);
  assert.equal(payload.issueMutation, false);
  assert.equal(payload.systemdOutcome, 'handled');
});
