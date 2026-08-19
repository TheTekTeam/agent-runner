import assert from 'node:assert/strict';
import test from 'node:test';

import { loadManagerProfileRegistry } from './agent-runner-manager-profile-registry.mjs';
import {
  assertNormalizedManagerProjectEvidenceShape,
  MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION,
  validateManagerProjectEvidence,
} from './agent-runner-manager-project-evidence.mjs';

const registry = loadManagerProfileRegistry();
const agentRunnerProfile = registry.projectsById['agent-runner'];
const modelspendProfile = registry.projectsById.modelspend;
const disabledFixtureProfile = registry.projectsById['fixture-third-project'];

const SOURCE_SHA = 'a'.repeat(40);
const DOC_SHA = 'b'.repeat(64);

function evidenceFor(profile, overrides = {}) {
  return {
    schemaVersion: MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION,
    projectId: profile.projectId,
    repository: { owner: profile.repository.owner, name: profile.repository.name },
    branch: profile.branches.default,
    sourceSha: SOURCE_SHA,
    evidenceRevision: 'evidence-2026-08-20.1',
    evidenceTimestamp: '2026-08-20T00:00:00Z',
    instructionDocuments: profile.instructionPaths.map((path) => ({ path, sha256: DOC_SHA, freshness: 'current' })),
    tooling: {
      languages: ['javascript'],
      packageManagers: ['npm'],
      buildTools: ['node'],
      workflows: ['github-actions'],
    },
    acceptanceCommands: [profile.validation.requiredChecks[0]],
    openIssues: [{ number: 1, title: 'Sample open issue', labels: [profile.labels.ready] }],
    openPullRequests: [{ number: 2, title: 'Sample open pull request', headSha: SOURCE_SHA }],
    ...overrides,
  };
}

test('builds valid evidence for the Agent Runner profile', () => {
  const evidence = validateManagerProjectEvidence(evidenceFor(agentRunnerProfile), { profile: agentRunnerProfile });
  assert.equal(evidence.projectId, 'agent-runner');
  assert.equal(evidence.repository.full, 'TheTekTeam/agent-runner');
  assert.ok(Object.isFrozen(evidence));
  assert.ok(evidence.evidenceFingerprint.startsWith('sha256:'));
  assert.doesNotThrow(() => assertNormalizedManagerProjectEvidenceShape(evidence));
});

test('builds valid evidence for the ModelSpend profile with the same code path', () => {
  const evidence = validateManagerProjectEvidence(evidenceFor(modelspendProfile), { profile: modelspendProfile });
  assert.equal(evidence.projectId, 'modelspend');
  assert.equal(evidence.repository.full, 'TheTekTeam/modelspend');
  assert.doesNotThrow(() => assertNormalizedManagerProjectEvidenceShape(evidence));
});

test('refuses to construct evidence for the disabled fixture-third-project profile', () => {
  assert.throws(
    () => validateManagerProjectEvidence(evidenceFor(disabledFixtureProfile), { profile: disabledFixtureProfile }),
    /evidence cannot be constructed for a disabled manager profile/,
  );
});

test('rejects an unknown top-level field', () => {
  assert.throws(
    () => validateManagerProjectEvidence(evidenceFor(agentRunnerProfile, { extra: true }), { profile: agentRunnerProfile }),
    /evidence\.extra is not a recognised field/,
  );
});

test('rejects a repository that does not match the profile', () => {
  assert.throws(
    () => validateManagerProjectEvidence(
      evidenceFor(agentRunnerProfile, { repository: { owner: 'Someone', name: 'else' } }),
      { profile: agentRunnerProfile },
    ),
    /repository must exactly match the registered profile repository/,
  );
});

test('rejects a branch outside the profile\'s allowed branches', () => {
  assert.throws(
    () => validateManagerProjectEvidence(evidenceFor(agentRunnerProfile, { branch: 'develop' }), { profile: agentRunnerProfile }),
    /branch must be one of the profile's declared branches\.allowed/,
  );
});

test('rejects a malformed source SHA', () => {
  assert.throws(
    () => validateManagerProjectEvidence(evidenceFor(agentRunnerProfile, { sourceSha: 'not-a-sha' }), { profile: agentRunnerProfile }),
    /sourceSha must be a 40-character hex commit SHA/,
  );
});

test('rejects an instruction document path outside the profile\'s declared instructionPaths', () => {
  assert.throws(
    () => validateManagerProjectEvidence(
      evidenceFor(agentRunnerProfile, { instructionDocuments: [{ path: 'SECRET.md', sha256: DOC_SHA, freshness: 'current' }] }),
      { profile: agentRunnerProfile },
    ),
    /instructionDocuments\[0\]\.path must be one of the profile's declared instructionPaths/,
  );
});

test('rejects an acceptance command that is not one of the profile\'s configured requiredChecks', () => {
  assert.throws(
    () => validateManagerProjectEvidence(
      evidenceFor(agentRunnerProfile, { acceptanceCommands: ['rm -rf /'] }),
      { profile: agentRunnerProfile },
    ),
    /acceptanceCommands\[0\] must exactly match one of the profile's configured validation\.requiredChecks/,
  );
});

test('rejects a local-machine path smuggled into an open issue title', () => {
  assert.throws(
    () => validateManagerProjectEvidence(
      evidenceFor(agentRunnerProfile, { openIssues: [{ number: 1, title: 'See /home/operator/secret.txt for details' }] }),
      { profile: agentRunnerProfile },
    ),
    /must not contain a local-machine path/,
  );
});

test('rejects a secret-shaped token in an open pull request title', () => {
  assert.throws(
    () => validateManagerProjectEvidence(
      evidenceFor(agentRunnerProfile, {
        openPullRequests: [{ number: 2, title: 'token ghp_abcdefghijklmnopqrstuvwx1234' }],
      }),
      { profile: agentRunnerProfile },
    ),
    /must not contain a secret or credential-shaped token/,
  );
});

test('rejects an evidence object that was never produced by validateManagerProjectEvidence', () => {
  const real = validateManagerProjectEvidence(evidenceFor(agentRunnerProfile), { profile: agentRunnerProfile });
  const fake = Object.freeze({ ...real });
  assert.notEqual(fake, real);
  assert.throws(() => assertNormalizedManagerProjectEvidenceShape(fake), /already-validated manager project evidence snapshot/);
});

test('is deterministic: identical input yields an identical fingerprint', () => {
  const first = validateManagerProjectEvidence(evidenceFor(agentRunnerProfile), { profile: agentRunnerProfile });
  const second = validateManagerProjectEvidence(evidenceFor(agentRunnerProfile), { profile: agentRunnerProfile });
  assert.equal(first.evidenceFingerprint, second.evidenceFingerprint);
});

test('a different sourceSha changes the fingerprint', () => {
  const first = validateManagerProjectEvidence(evidenceFor(agentRunnerProfile), { profile: agentRunnerProfile });
  const second = validateManagerProjectEvidence(
    evidenceFor(agentRunnerProfile, { sourceSha: 'c'.repeat(40) }),
    { profile: agentRunnerProfile },
  );
  assert.notEqual(first.evidenceFingerprint, second.evidenceFingerprint);
});
