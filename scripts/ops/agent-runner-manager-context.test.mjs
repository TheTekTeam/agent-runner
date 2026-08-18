import assert from 'node:assert/strict';
import test from 'node:test';

import { MANAGER_PROFILE_SCHEMA_VERSION, validateManagerProfile } from './agent-runner-manager-profile-schema.mjs';
import { MANAGER_CONTEXT_SCHEMA_VERSION, resolveManagerContext } from './agent-runner-manager-context.mjs';

function enabledProfile(overrides = {}) {
  return validateManagerProfile({
    schemaVersion: MANAGER_PROFILE_SCHEMA_VERSION,
    projectId: 'sample',
    enabled: true,
    repository: { owner: 'Owner', name: 'Sample' },
    branches: { allowed: ['main'], default: 'main' },
    objective: 'Ship the sample project.',
    nonGoals: [],
    instructionPaths: ['CLAUDE.md'],
    controlIssue: { mode: 'labelSelector', labelSelector: 'status:ready' },
    labels: { ready: 'status:ready' },
    capabilities: { allowlist: ['claude-code-cli'] },
    validation: { profile: 'complex', requiredChecks: ['npm test'] },
    quotaPolicyRef: 'scripts/ops/agent-runner-routing.mjs#quota-only-admission',
    mutationBounds: { maxIssueMutationsPerRecurrence: 2, maxCommentsPerRecurrence: 3 },
    escalation: { rules: ['Stop on ambiguity'] },
    mutationAuthority: {
      issueMutation: true,
      authorityIssuance: true,
      merge: true,
      close: true,
      deploy: true,
      sourceActivation: true,
    },
    ...overrides,
  });
}

test('refuses to resolve an unvalidated input', () => {
  assert.throws(() => resolveManagerContext({ projectId: 'sample' }), /already-validated manager profile/);
});

test('refuses an adversarial object that merely carries a correct schemaVersion but is not frozen or structurally validated', () => {
  const fake = {
    schemaVersion: MANAGER_PROFILE_SCHEMA_VERSION,
    projectId: 'sample',
    enabled: true,
    mutationAuthority: { issueMutation: true, authorityIssuance: true, merge: true, close: true, deploy: true, sourceActivation: true },
  };
  assert.throws(() => resolveManagerContext(fake), /already-validated manager profile/);
});

test('an enabled profile preserves its declared mutation authority and bounds', () => {
  const context = resolveManagerContext(enabledProfile());
  assert.equal(context.schemaVersion, MANAGER_CONTEXT_SCHEMA_VERSION);
  assert.deepEqual(context.mutationAuthority, {
    issueMutation: true,
    authorityIssuance: true,
    merge: true,
    close: true,
    deploy: true,
    sourceActivation: true,
  });
  assert.deepEqual(context.mutationBounds, { maxIssueMutationsPerRecurrence: 2, maxCommentsPerRecurrence: 3 });
});

test('a disabled profile always resolves to zero mutation authority even if the raw profile declared true', () => {
  const profile = enabledProfile({ enabled: false });
  const context = resolveManagerContext(profile);
  assert.equal(context.enabled, false);
  assert.deepEqual(context.mutationAuthority, {
    issueMutation: false,
    authorityIssuance: false,
    merge: false,
    close: false,
    deploy: false,
    sourceActivation: false,
  });
  assert.deepEqual(context.mutationBounds, { maxIssueMutationsPerRecurrence: 0, maxCommentsPerRecurrence: 0 });
});

test('resolution is a pure function: repeated calls on the same profile are deep-equal', () => {
  const profile = enabledProfile();
  assert.deepEqual(resolveManagerContext(profile), resolveManagerContext(profile));
});

test('the resolved context is frozen at every level relevant to mutation safety', () => {
  const context = resolveManagerContext(enabledProfile());
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.mutationAuthority));
  assert.ok(Object.isFrozen(context.mutationBounds));
});
