import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AdmissionCircuitBreaker,
  circuitPausePayload,
} from './agent-runner-circuit-breaker.mjs';

function withBreaker(run) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-circuit-'));
  const dbPath = join(dir, 'circuit.sqlite');
  const breaker = new AdmissionCircuitBreaker(dbPath, { now: () => '2026-07-21T00:00:00.000Z' });
  try {
    return run(breaker);
  } finally {
    breaker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('one machine-profile refusal trips immediately for unchanged configuration', () => withBreaker((breaker) => {
  const recorded = breaker.record({
    scope: 'machine_profile',
    reason: 'implementation-machine-opt-in-disabled',
    configurationFingerprint: 'sha256:a',
  });
  assert.equal(recorded.tripped, true);
  assert.equal(recorded.newlyTripped, true);
  const current = breaker.check({ configurationFingerprint: 'sha256:a' });
  assert.equal(current.blocked, true);
  assert.equal(current.occurrenceCount, 1);
}));

test('repeated identical machine-profile refusal is deduplicated', () => withBreaker((breaker) => {
  const first = breaker.record({ scope: 'machine_profile', reason: 'adapter-unavailable', configurationFingerprint: 'sha256:a' });
  const second = breaker.record({ scope: 'machine_profile', reason: 'adapter-unavailable', configurationFingerprint: 'sha256:a' });
  assert.equal(first.newlyTripped, true);
  assert.equal(second.newlyTripped, false);
  assert.equal(breaker.markNotificationEmitted('machine_profile'), true);
  assert.equal(breaker.markNotificationEmitted('machine_profile'), false);
}));

test('changed machine configuration clears the profile circuit', () => withBreaker((breaker) => {
  breaker.record({ scope: 'machine_profile', reason: 'implementation-machine-opt-in-disabled', configurationFingerprint: 'sha256:a' });
  assert.equal(breaker.check({ configurationFingerprint: 'sha256:b' }).blocked, false);
  assert.equal(breaker.check({ configurationFingerprint: 'sha256:a' }).blocked, false);
}));

test('systemic reason requires two matching failures within the window', () => withBreaker((breaker) => {
  const first = breaker.record({ scope: 'systemic', reason: 'state-unavailable', configurationFingerprint: 'sha256:a' });
  const second = breaker.record({ scope: 'systemic', reason: 'state-unavailable', configurationFingerprint: 'sha256:a' });
  assert.equal(first.tripped, false);
  assert.equal(second.tripped, true);
  assert.equal(breaker.check({ configurationFingerprint: 'sha256:a' }).blocked, true);
}));

test('circuit pause proves no candidate consumption or mutation', () => {
  const payload = circuitPausePayload({
    scope: 'machine_profile',
    reason: 'implementation-machine-opt-in-disabled',
    configurationFingerprint: 'sha256:a',
    occurrenceCount: 1,
    safeNextAction: 'Change configuration.',
  });
  assert.equal(payload.selectedIssue, null);
  assert.equal(payload.attemptCreated, false);
  assert.equal(payload.childLaunched, false);
  assert.equal(payload.issueMutation, false);
  assert.equal(payload.systemdOutcome, 'handled');
});

test('standalone launcher checks the circuit before candidate discovery and records profile refusal', () => {
  const source = readFileSync(new URL('../../bin/run-project.sh', import.meta.url), 'utf8');
  const check = source.indexOf('agent-runner-circuit-breaker.mjs" check');
  const admission = source.indexOf('agent-runner-admission.mjs');
  const candidate = source.indexOf('claude-runner-candidate-probe.mjs');
  assert.ok(check >= 0 && check < admission && admission < candidate);
  assert.match(source, /AGENT_RUNNER_ADMISSION_RESULT=.*agent-runner-circuit-breaker\.mjs" record/s);
  assert.match(source, /CIRCUIT_STATUS[\s\S]*3\).*exit 0/);
});
