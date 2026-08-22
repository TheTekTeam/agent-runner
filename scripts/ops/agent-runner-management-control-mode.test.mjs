import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORBIDDEN_MANAGEMENT_CAPABILITIES,
  MANAGEMENT_CONTROL_MODES,
  MANAGEMENT_ROLES,
  ROLE_BY_EVENT_TYPE,
  assertResolvedRoleCapabilities,
  createAssuranceCapabilities,
  hasCapability,
  resolveManagementControlMode,
  resolveRoleCapabilities,
} from './agent-runner-management-control-mode.mjs';
import { MANAGEMENT_EVENT_TYPES } from './agent-runner-management-events.mjs';

const collectEvidence = () => ({});
const noop = () => {};

function programmePorts(overrides = {}) {
  return { collectEvidence, applyQueueMutation: noop, publishWorkerAuthority: noop, ...overrides };
}

test('the bounded mode set is exactly disabled, shadow, active and fenced', () => {
  assert.deepEqual([...MANAGEMENT_CONTROL_MODES], ['disabled', 'shadow', 'active', 'fenced']);
  assert.deepEqual([...MANAGEMENT_ROLES], ['programme', 'execution', 'assurance']);
});

test('every role-dispatchable event type is an allowlisted management event type', () => {
  for (const eventType of Object.keys(ROLE_BY_EVENT_TYPE)) {
    assert.ok(MANAGEMENT_EVENT_TYPES.includes(eventType), `${eventType} must be a #289 event type`);
  }
});

test('active mode processes and mutates', () => {
  const resolved = resolveManagementControlMode({ mode: 'active' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.processing, true);
  assert.equal(resolved.mutating, true);
  assert.equal(resolved.mutationSuppressed, false);
});

test('shadow mode processes but never mutates', () => {
  const resolved = resolveManagementControlMode({ mode: 'shadow' });
  assert.equal(resolved.processing, true);
  assert.equal(resolved.mutating, false);
  assert.equal(resolved.mutationSuppressed, true);
});

test('disabled and fenced both stop processing and stay distinguishable', () => {
  for (const mode of ['disabled', 'fenced']) {
    const resolved = resolveManagementControlMode({ mode });
    assert.equal(resolved.ok, true, mode);
    assert.equal(resolved.processing, false, mode);
    assert.equal(resolved.mutating, false, mode);
    assert.equal(resolved.mode, mode);
  }
});

test('an unknown, absent or malformed mode fails closed without throwing', () => {
  for (const input of [{}, { mode: null }, { mode: '' }, { mode: 'ACTIVE' }, { mode: 'enabled' }, { mode: 42 }]) {
    const resolved = resolveManagementControlMode(input);
    assert.equal(resolved.ok, false, JSON.stringify(input));
    assert.equal(resolved.processing, false);
    assert.equal(resolved.mutating, false);
    assert.equal(resolved.mode, null);
  }
  assert.equal(resolveManagementControlMode({ mode: 'active', extra: true }).ok, false);
  assert.equal(resolveManagementControlMode('active').ok, false);
});

test('programme is the only role granted mutating capabilities in active mode', () => {
  const programme = resolveRoleCapabilities({ role: 'programme', mode: 'active', ports: programmePorts() });
  assert.equal(hasCapability(programme, 'applyQueueMutation'), true);
  assert.equal(hasCapability(programme, 'publishWorkerAuthority'), true);

  const execution = resolveRoleCapabilities({
    role: 'execution', mode: 'active', ports: { collectEvidence, publishContinuationAuthority: noop },
  });
  assert.equal(hasCapability(execution, 'publishContinuationAuthority'), true);
  // Execution can never curate a queue or mint a fresh worker authority.
  assert.equal(hasCapability(execution, 'applyQueueMutation'), false);
  assert.equal(hasCapability(execution, 'publishWorkerAuthority'), false);
});

test('shadow mode suppresses every mutating capability while keeping the read surface', () => {
  const programme = resolveRoleCapabilities({ role: 'programme', mode: 'shadow', ports: programmePorts() });
  assert.equal(hasCapability(programme, 'collectEvidence'), true);
  assert.equal(hasCapability(programme, 'applyQueueMutation'), false);
  assert.equal(hasCapability(programme, 'publishWorkerAuthority'), false);
  assert.deepEqual([...programme.suppressed], ['applyQueueMutation', 'publishWorkerAuthority']);
  assert.equal(programme.mutationSuppressed, true);
  // The port is absent, not present-and-refusing, so a handler cannot reach it.
  assert.equal('applyQueueMutation' in programme.ports, false);
});

test('a non-processing or unknown mode cannot produce capabilities at all', () => {
  for (const mode of ['disabled', 'fenced']) {
    assert.throws(
      () => resolveRoleCapabilities({ role: 'programme', mode, ports: programmePorts() }),
      /does not process events/,
    );
  }
  assert.throws(() => resolveRoleCapabilities({ role: 'programme', mode: 'nonsense', ports: programmePorts() }), /unknown management control mode/);
  assert.throws(() => resolveRoleCapabilities({ role: 'auditor', mode: 'active', ports: { collectEvidence } }), /unknown management role/);
});

test('a forbidden capability can never be supplied to any role', () => {
  for (const name of FORBIDDEN_MANAGEMENT_CAPABILITIES) {
    assert.throws(
      () => resolveRoleCapabilities({ role: 'programme', mode: 'active', ports: { ...programmePorts(), [name]: noop } }),
      /forbidden capability/,
      name,
    );
  }
});

test('a port for a capability the role does not own is a wiring error, never a silent grant', () => {
  assert.throws(
    () => resolveRoleCapabilities({
      role: 'execution', mode: 'active', ports: { collectEvidence, publishWorkerAuthority: noop },
    }),
    /must not be supplied the 'publishWorkerAuthority' port/,
  );
});

test('a missing mandatory read port fails closed rather than degrading the handler', () => {
  assert.throws(
    () => resolveRoleCapabilities({ role: 'programme', mode: 'active', ports: { applyQueueMutation: noop, publishWorkerAuthority: noop } }),
    /requires the 'collectEvidence' port/,
  );
});

test('a mutating port missing in active mode fails closed rather than silently behaving like shadow', () => {
  // Silently suppressing it would make an `active` controller mutate nothing
  // while still reporting itself as the mutating authority.
  assert.throws(
    () => resolveRoleCapabilities({ role: 'programme', mode: 'active', ports: { collectEvidence, publishWorkerAuthority: noop } }),
    /requires the 'applyQueueMutation' port in 'active' mode/,
  );
  assert.throws(
    () => resolveRoleCapabilities({ role: 'execution', mode: 'active', ports: { collectEvidence } }),
    /requires the 'publishContinuationAuthority' port in 'active' mode/,
  );
  // Shadow never needs them: they are suppressed before the port is consulted.
  const shadow = resolveRoleCapabilities({ role: 'execution', mode: 'shadow', ports: { collectEvidence } });
  assert.deepEqual([...shadow.suppressed], ['publishContinuationAuthority']);
});

test('assurance holds no mutating capability in any processing mode', () => {
  for (const mode of ['shadow', 'active']) {
    const assurance = createAssuranceCapabilities({ mode, readers: { collectEvidence } });
    assert.equal(hasCapability(assurance, 'collectEvidence'), true);
    for (const name of ['applyQueueMutation', 'publishWorkerAuthority', 'publishContinuationAuthority']) {
      assert.equal(hasCapability(assurance, name), false, `${mode}/${name}`);
      assert.equal(name in assurance.ports, false, `${mode}/${name}`);
    }
  }
});

test('offering assurance a mutating port is refused at construction time', () => {
  for (const name of ['applyQueueMutation', 'publishWorkerAuthority', 'publishContinuationAuthority']) {
    assert.throws(
      () => createAssuranceCapabilities({ mode: 'active', readers: { collectEvidence, [name]: noop } }),
      /read-only assurance must never be supplied the mutating capability/,
      name,
    );
  }
  assert.throws(
    () => createAssuranceCapabilities({ mode: 'active', readers: { collectEvidence, merge: noop } }),
    /read-only assurance must never be supplied the mutating capability 'merge'/,
  );
});

test('a hand-built look-alike capability object is refused', () => {
  const forged = Object.freeze({ role: 'programme', mode: 'active', ports: Object.freeze({ collectEvidence }) });
  assert.throws(() => assertResolvedRoleCapabilities(forged), /was not produced by resolveRoleCapabilities/);
  const real = resolveRoleCapabilities({ role: 'programme', mode: 'active', ports: programmePorts() });
  assert.throws(() => assertResolvedRoleCapabilities(real, { role: 'assurance' }), /role capability mismatch/);
  assert.equal(assertResolvedRoleCapabilities(real, { role: 'programme' }), real);
});
