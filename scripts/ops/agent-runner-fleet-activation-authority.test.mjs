import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLEET_ACTIVATION_AUTHORITY_MARKER,
  FLEET_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
  fleetActivationAuthorityFingerprint,
  parseFleetActivationAuthority,
  resolveFleetActivationAuthority,
} from './agent-runner-fleet-activation-authority.mjs';

const SOURCE = '1'.repeat(40);
const REGISTRY_FINGERPRINT = `sha256:${'2'.repeat(64)}`;
const CONTROL_ISSUE = 402;
const INSTANCE = 'codex-cli@dev-cluster-z790';
const ENV = { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola' };

function authorityComment({
  id = 100,
  login = 'gpcola',
  revision = 'AR402-FLEET-ACTIVATION-1',
  source = SOURCE,
  registryRevision = 7,
  registryFingerprint = REGISTRY_FINGERPRINT,
  instanceId = INSTANCE,
  targetState = 'enabled',
  issue = CONTROL_ISSUE,
  reason = 'supervised-fleet-lifecycle-acceptance',
  fingerprintOverride = null,
} = {}) {
  const material = {
    schema_version: FLEET_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
    revision,
    target_repository: 'TheTekTeam/agent-runner',
    target_issue: issue,
    target_source_commit: source,
    target_registry_revision: registryRevision,
    target_registry_fingerprint: registryFingerprint,
    target_instance: instanceId,
    target_state: targetState,
    producer_type: 'normal_chatgpt_manager_session',
    reason,
  };
  const fingerprint = fingerprintOverride || fleetActivationAuthorityFingerprint(material);
  const body = `${FLEET_ACTIVATION_AUTHORITY_MARKER}
\`\`\`yaml
schema_version: ${material.schema_version}
revision: ${material.revision}
target_repository: ${material.target_repository}
target_issue: ${material.target_issue}
target_source_commit: ${material.target_source_commit}
target_registry_revision: ${material.target_registry_revision}
target_registry_fingerprint: ${material.target_registry_fingerprint}
target_instance: ${material.target_instance}
target_state: ${material.target_state}
producer_type: ${material.producer_type}
reason: ${material.reason}
fingerprint: ${fingerprint}
\`\`\`
`;
  return { id, user: { login }, body };
}

function resolve(comment, overrides = {}) {
  return resolveFleetActivationAuthority({
    comments: overrides.comments || [comment],
    env: overrides.env || ENV,
    controlIssue: overrides.controlIssue || CONTROL_ISSUE,
    requestedCommentId: overrides.requestedCommentId || comment.id,
    currentSourceCommit: overrides.currentSourceCommit || SOURCE,
    registry: overrides.registry || {
      documentRevision: 7,
      registryFingerprint: REGISTRY_FINGERPRINT,
    },
    instanceId: overrides.instanceId || INSTANCE,
    targetState: overrides.targetState || 'enabled',
    previousTransition: overrides.previousTransition || null,
  });
}

test('fleet activation authority fingerprint is recomputed and exact target is accepted', () => {
  const comment = authorityComment();
  const parsed = parseFleetActivationAuthority(comment);
  assert.equal(parsed.targetSourceCommit, SOURCE);
  assert.equal(parsed.targetRegistryRevision, 7);
  assert.equal(parsed.targetRegistryFingerprint, REGISTRY_FINGERPRINT);
  assert.equal(parsed.targetInstanceId, INSTANCE);
  assert.equal(parsed.targetState, 'enabled');
  const resolved = resolve(comment);
  assert.equal(resolved.author, 'gpcola');
  assert.match(resolved.authorityKey, /^fleet-activation:/);
  assert.match(resolved.bodyDigest, /^sha256:[a-f0-9]{64}$/);
});

test('tampered fingerprint, unapproved author and stale target evidence fail closed', () => {
  assert.throws(
    () => parseFleetActivationAuthority(authorityComment({ fingerprintOverride: `sha256:${'f'.repeat(64)}` })),
    /fleet-activation-authority-invalid/,
  );
  assert.throws(() => resolve(authorityComment({ login: 'worker-bot' })), /fleet-activation-author-unapproved/);
  assert.throws(
    () => resolve(authorityComment(), { currentSourceCommit: '3'.repeat(40) }),
    /fleet-activation-authority-source-mismatch/,
  );
  assert.throws(
    () => resolve(authorityComment(), {
      registry: { documentRevision: 8, registryFingerprint: REGISTRY_FINGERPRINT },
    }),
    /fleet-activation-authority-registry-revision-mismatch/,
  );
  assert.throws(
    () => resolve(authorityComment(), {
      registry: { documentRevision: 7, registryFingerprint: `sha256:${'4'.repeat(64)}` },
    }),
    /fleet-activation-authority-registry-fingerprint-mismatch/,
  );
  assert.throws(() => resolve(authorityComment(), { targetState: 'disabled' }), /fleet-activation-authority-state-mismatch/);
  assert.throws(
    () => resolve(authorityComment(), { instanceId: 'claude-code-cli@dev-cluster-z790' }),
    /fleet-activation-authority-instance-mismatch/,
  );
});

test('only the latest exact fleet authority comment is usable', () => {
  const first = authorityComment({ id: 100, revision: 'AR402-FLEET-ACTIVATION-1' });
  const second = authorityComment({ id: 101, revision: 'AR402-FLEET-ACTIVATION-2' });
  assert.throws(
    () => resolve(first, { comments: [first, second], requestedCommentId: first.id }),
    /fleet-activation-authority-not-latest/,
  );
  assert.equal(resolve(second, { comments: [first, second] }).commentId, second.id);
});

test('previous consumed authority comment must remain present and byte-identical', () => {
  const first = authorityComment({ id: 100, revision: 'AR402-FLEET-ACTIVATION-1' });
  const firstResolved = resolve(first);
  const second = authorityComment({
    id: 101,
    revision: 'AR402-FLEET-ACTIVATION-2',
    registryRevision: 8,
    registryFingerprint: `sha256:${'5'.repeat(64)}`,
    targetState: 'disabled',
  });
  const previousTransition = {
    authorityCommentId: firstResolved.commentId,
    authorityBodyDigest: firstResolved.bodyDigest,
  };
  const secondResolved = resolveFleetActivationAuthority({
    comments: [first, second],
    env: ENV,
    controlIssue: CONTROL_ISSUE,
    requestedCommentId: second.id,
    currentSourceCommit: SOURCE,
    registry: { documentRevision: 8, registryFingerprint: `sha256:${'5'.repeat(64)}` },
    instanceId: INSTANCE,
    targetState: 'disabled',
    previousTransition,
  });
  assert.equal(secondResolved.commentId, 101);

  const edited = { ...first, body: `${first.body}\nedited` };
  assert.throws(
    () => resolveFleetActivationAuthority({
      comments: [edited, second],
      env: ENV,
      controlIssue: CONTROL_ISSUE,
      requestedCommentId: second.id,
      currentSourceCommit: SOURCE,
      registry: { documentRevision: 8, registryFingerprint: `sha256:${'5'.repeat(64)}` },
      instanceId: INSTANCE,
      targetState: 'disabled',
      previousTransition,
    }),
    /fleet-activation-previous-authority-edited/,
  );
});

test('empty or malformed approved-manager policy refuses authority', () => {
  const comment = authorityComment();
  assert.throws(() => resolve(comment, { env: {} }), /fleet-activation-approver-policy-invalid/);
  assert.throws(
    () => resolve(comment, { env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'bad login!' } }),
    /fleet-activation-approver-policy-invalid/,
  );
});
