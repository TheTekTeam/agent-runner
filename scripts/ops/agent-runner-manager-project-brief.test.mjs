import assert from 'node:assert/strict';
import test from 'node:test';

import { loadManagerProfileRegistry } from './agent-runner-manager-profile-registry.mjs';
import { MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION, validateManagerProjectEvidence } from './agent-runner-manager-project-evidence.mjs';
import {
  assertNormalizedManagerProjectBriefShape,
  MANAGER_PROJECT_BRIEF_SCHEMA_VERSION,
  validateManagerProjectBrief,
} from './agent-runner-manager-project-brief.mjs';

const registry = loadManagerProfileRegistry();
const agentRunnerProfile = registry.projectsById['agent-runner'];
const modelspendProfile = registry.projectsById.modelspend;

const SOURCE_SHA = 'a'.repeat(40);
const DOC_SHA = 'b'.repeat(64);

function evidenceFor(profile) {
  return validateManagerProjectEvidence({
    schemaVersion: MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION,
    projectId: profile.projectId,
    repository: { owner: profile.repository.owner, name: profile.repository.name },
    branch: profile.branches.default,
    sourceSha: SOURCE_SHA,
    evidenceRevision: 'evidence-2026-08-20.1',
    evidenceTimestamp: '2026-08-20T00:00:00Z',
    instructionDocuments: profile.instructionPaths.map((path) => ({ path, sha256: DOC_SHA, freshness: 'current' })),
    tooling: {
      languages: ['javascript'], packageManagers: ['npm'], buildTools: ['node'], workflows: ['github-actions'],
    },
    acceptanceCommands: [profile.validation.requiredChecks[0]],
    openIssues: [],
    openPullRequests: [],
  }, { profile });
}

function briefInput(overrides = {}) {
  return {
    schemaVersion: MANAGER_PROJECT_BRIEF_SCHEMA_VERSION,
    objective: 'Ship the planner foundation slice.',
    outcome: 'Manager can turn bounded evidence into a validated brief and plan.',
    constraints: ['Read-only, no GitHub writes'],
    nonGoals: ['Queue curation', 'Dispatch'],
    architectureSummary: 'Node.js scripts under scripts/ops validated with node:test.',
    risks: ['Evidence could go stale between recurrences'],
    assumptions: ['Evidence was collected from the exact accepted source SHA'],
    blockers: [],
    escalationQuestions: ['Should queue curation be a separate accepted slice?'],
    definitionOfDone: ['Targeted tests pass', 'npm run validate passes'],
    ...overrides,
  };
}

test('builds a valid brief for the Agent Runner evidence, grounded in evidence tooling', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  const brief = validateManagerProjectBrief(briefInput(), { evidence });
  assert.equal(brief.projectId, 'agent-runner');
  assert.deepEqual(brief.architecture.languages, evidence.tooling.languages);
  assert.equal(brief.architecture.summary, briefInput().architectureSummary);
  assert.ok(brief.briefFingerprint.startsWith('sha256:'));
  assert.ok(Object.isFrozen(brief));
  assert.doesNotThrow(() => assertNormalizedManagerProjectBriefShape(brief));
});

test('builds a valid brief for the ModelSpend evidence with the same code path', () => {
  const evidence = evidenceFor(modelspendProfile);
  const brief = validateManagerProjectBrief(briefInput(), { evidence });
  assert.equal(brief.projectId, 'modelspend');
  assert.doesNotThrow(() => assertNormalizedManagerProjectBriefShape(brief));
});

test('rejects an unknown top-level field', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  assert.throws(
    () => validateManagerProjectBrief(briefInput({ extra: true }), { evidence }),
    /brief\.extra is not a recognised field/,
  );
});

test('rejects a missing definitionOfDone', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  const input = briefInput();
  delete input.definitionOfDone;
  assert.throws(() => validateManagerProjectBrief(input, { evidence }), /brief\.definitionOfDone is required/);
});

test('rejects an empty definitionOfDone list', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  assert.throws(
    () => validateManagerProjectBrief(briefInput({ definitionOfDone: [] }), { evidence }),
    /brief\.definitionOfDone must contain at least 1 entry/,
  );
});

test('rejects an over-long objective', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  assert.throws(
    () => validateManagerProjectBrief(briefInput({ objective: 'x'.repeat(700) }), { evidence }),
    /brief\.objective must be at most 600 characters/,
  );
});

test('rejects a local-machine path in a risk entry', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  assert.throws(
    () => validateManagerProjectBrief(briefInput({ risks: ['Config lives at /home/operator/.config/secret'] }), { evidence }),
    /must not contain a local-machine path/,
  );
});

test('rejects a shell payload in an assumption', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  assert.throws(
    () => validateManagerProjectBrief(briefInput({ assumptions: ['Safe unless $(rm -rf /) runs'] }), { evidence }),
    /must not contain a shell command or executable payload/,
  );
});

test('rejects a brief built from an evidence look-alike that was never validated', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  const fakeEvidence = Object.freeze({ ...evidence });
  assert.throws(
    () => validateManagerProjectBrief(briefInput(), { evidence: fakeEvidence }),
    /already-validated manager project evidence snapshot/,
  );
});

test('rejects a brief object that was never produced by validateManagerProjectBrief', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  const real = validateManagerProjectBrief(briefInput(), { evidence });
  const fake = Object.freeze({ ...real });
  assert.notEqual(fake, real);
  assert.throws(() => assertNormalizedManagerProjectBriefShape(fake), /already-validated manager project brief/);
});

test('is deterministic: identical evidence and input yield an identical fingerprint', () => {
  const evidence = evidenceFor(agentRunnerProfile);
  const first = validateManagerProjectBrief(briefInput(), { evidence });
  const second = validateManagerProjectBrief(briefInput(), { evidence });
  assert.equal(first.briefFingerprint, second.briefFingerprint);
});
