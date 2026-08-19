import assert from 'node:assert/strict';
import test from 'node:test';

import { loadManagerProfileRegistry } from './agent-runner-manager-profile-registry.mjs';
import { MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION, validateManagerProjectEvidence } from './agent-runner-manager-project-evidence.mjs';
import { MANAGER_PROJECT_BRIEF_SCHEMA_VERSION, validateManagerProjectBrief } from './agent-runner-manager-project-brief.mjs';
import {
  assertNormalizedManagerPlanProposalShape,
  MANAGER_PLAN_PROPOSAL_SCHEMA_VERSION,
  serializeManagerPlanProposal,
  validateManagerPlanProposal,
} from './agent-runner-manager-plan-proposal.mjs';

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

function briefFor(profile) {
  const evidence = evidenceFor(profile);
  return validateManagerProjectBrief({
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
  }, { evidence });
}

function groundingFor(brief) {
  return { repository: brief.repository, branch: brief.branch, sourceSha: brief.sourceSha };
}

function proposalInput(brief, overrides = {}) {
  return {
    schemaVersion: MANAGER_PLAN_PROPOSAL_SCHEMA_VERSION,
    grounding: groundingFor(brief),
    milestones: [
      { id: 'evidence', title: 'Evidence snapshot', description: 'Provider-neutral bounded evidence contract.', dependsOn: [] },
      { id: 'brief', title: 'Project brief', description: 'Validated normalized brief derived from evidence.', dependsOn: ['evidence'] },
    ],
    proposedIssues: [
      {
        id: 'evidence-schema',
        milestoneId: 'evidence',
        title: 'Define evidence schema',
        scope: 'Add the evidence validator and fixtures.',
        acceptanceCriteria: ['Targeted tests pass'],
        decisionType: 'implementation',
      },
      {
        id: 'brief-fields',
        milestoneId: 'brief',
        title: 'Choose brief fields',
        scope: 'Decide which fields the brief must carry.',
        acceptanceCriteria: ['Fields match issue scope'],
        decisionType: 'product',
      },
    ],
    blockers: [],
    escalations: ['Confirm queue curation remains a separate slice'],
    ...overrides,
  };
}

test('builds a valid proposal for the Agent Runner brief with an acyclic milestone graph', () => {
  const brief = briefFor(agentRunnerProfile);
  const proposal = validateManagerPlanProposal(proposalInput(brief), { brief });
  assert.equal(proposal.projectId, 'agent-runner');
  assert.equal(proposal.milestones.length, 2);
  assert.equal(proposal.proposedIssues.length, 2);
  assert.ok(proposal.proposalFingerprint.startsWith('sha256:'));
  assert.ok(Object.isFrozen(proposal));
  assert.doesNotThrow(() => assertNormalizedManagerPlanProposalShape(proposal));
});

test('builds a valid proposal for the ModelSpend brief with the same code path', () => {
  const brief = briefFor(modelspendProfile);
  const proposal = validateManagerPlanProposal(proposalInput(brief), { brief });
  assert.equal(proposal.projectId, 'modelspend');
  assert.doesNotThrow(() => assertNormalizedManagerPlanProposalShape(proposal));
});

test('rejects an unknown top-level field', () => {
  const brief = briefFor(agentRunnerProfile);
  assert.throws(
    () => validateManagerPlanProposal(proposalInput(brief, { extra: true }), { brief }),
    /proposal\.extra is not a recognised field/,
  );
});

test('rejects a grounding sourceSha that does not match the underlying evidence', () => {
  const brief = briefFor(agentRunnerProfile);
  const grounding = { ...groundingFor(brief), sourceSha: 'c'.repeat(40) };
  assert.throws(
    () => validateManagerPlanProposal(proposalInput(brief, { grounding }), { brief }),
    /grounding\.sourceSha must exactly match the evidence sourceSha/,
  );
});

test('rejects a grounding repository that does not match the underlying evidence', () => {
  const brief = briefFor(agentRunnerProfile);
  const grounding = { ...groundingFor(brief), repository: 'SomeoneElse/other-repo' };
  assert.throws(
    () => validateManagerPlanProposal(proposalInput(brief, { grounding }), { brief }),
    /grounding\.repository must exactly match the evidence repository/,
  );
});

test('rejects a two-milestone dependency cycle', () => {
  const brief = briefFor(agentRunnerProfile);
  const milestones = [
    { id: 'a', title: 'Milestone A', description: 'First.', dependsOn: ['b'] },
    { id: 'b', title: 'Milestone B', description: 'Second.', dependsOn: ['a'] },
  ];
  const proposedIssues = [
    {
      id: 'issue-a', milestoneId: 'a', title: 'Issue A', scope: 'Scope A', acceptanceCriteria: ['Done A'], decisionType: 'implementation',
    },
  ];
  assert.throws(
    () => validateManagerPlanProposal(proposalInput(brief, { milestones, proposedIssues }), { brief }),
    /milestones contain a dependency cycle/,
  );
});

test('rejects a proposed issue referencing an unknown milestone', () => {
  const brief = briefFor(agentRunnerProfile);
  const input = proposalInput(brief);
  input.proposedIssues[0].milestoneId = 'not-declared';
  assert.throws(
    () => validateManagerPlanProposal(input, { brief }),
    /milestoneId must reference a milestone declared in this proposal/,
  );
});

test('rejects a milestone count above the configured bound', () => {
  const brief = briefFor(agentRunnerProfile);
  const milestones = Array.from({ length: 13 }, (_, index) => ({
    id: `milestone-${index}`, title: `Milestone ${index}`, description: 'Bounded description.', dependsOn: [],
  }));
  assert.throws(
    () => validateManagerPlanProposal(proposalInput(brief, { milestones }), { brief }),
    /milestones must be a non-empty array of at most 12 entries/,
  );
});

test('rejects an unsafe write-action phrase in a milestone description', () => {
  const brief = briefFor(agentRunnerProfile);
  const milestones = [
    { id: 'evidence', title: 'Evidence snapshot', description: 'Merge the draft PR once green.', dependsOn: [] },
  ];
  const proposedIssues = [
    {
      id: 'evidence-schema', milestoneId: 'evidence', title: 'Define evidence schema', scope: 'Scope', acceptanceCriteria: ['Done'], decisionType: 'implementation',
    },
  ];
  assert.throws(
    () => validateManagerPlanProposal(proposalInput(brief, { milestones, proposedIssues }), { brief }),
    /must not describe a write action/,
  );
});

test('rejects a shell payload in a proposed issue scope', () => {
  const brief = briefFor(agentRunnerProfile);
  const input = proposalInput(brief);
  input.proposedIssues[0].scope = 'Run $(rm -rf /) before starting';
  assert.throws(
    () => validateManagerPlanProposal(input, { brief }),
    /must not contain a shell command or executable payload/,
  );
});

test('rejects an invalid decisionType', () => {
  const brief = briefFor(agentRunnerProfile);
  const input = proposalInput(brief);
  input.proposedIssues[0].decisionType = 'strategic';
  assert.throws(() => validateManagerPlanProposal(input, { brief }), /decisionType must be one of product, implementation/);
});

test('rejects a proposal built from a brief look-alike that was never validated', () => {
  const brief = briefFor(agentRunnerProfile);
  const fakeBrief = Object.freeze({ ...brief });
  assert.throws(
    () => validateManagerPlanProposal(proposalInput(brief), { brief: fakeBrief }),
    /already-validated manager project brief/,
  );
});

test('rejects a proposal object that was never produced by validateManagerPlanProposal', () => {
  const brief = briefFor(agentRunnerProfile);
  const real = validateManagerPlanProposal(proposalInput(brief), { brief });
  const fake = Object.freeze({ ...real });
  assert.notEqual(fake, real);
  assert.throws(() => assertNormalizedManagerPlanProposalShape(fake), /already-validated manager plan proposal/);
});

test('is deterministic: identical evidence/brief/input yield an identical fingerprint and serialization', () => {
  const brief = briefFor(agentRunnerProfile);
  const first = validateManagerPlanProposal(proposalInput(brief), { brief });
  const secondBrief = briefFor(agentRunnerProfile);
  const second = validateManagerPlanProposal(proposalInput(secondBrief), { brief: secondBrief });
  assert.equal(first.proposalFingerprint, second.proposalFingerprint);
  assert.equal(serializeManagerPlanProposal(first), serializeManagerPlanProposal(second));
});

test('a different milestone graph changes the fingerprint', () => {
  const brief = briefFor(agentRunnerProfile);
  const first = validateManagerPlanProposal(proposalInput(brief), { brief });
  const changedInput = proposalInput(brief);
  changedInput.milestones[1].dependsOn = [];
  const second = validateManagerPlanProposal(changedInput, { brief });
  assert.notEqual(first.proposalFingerprint, second.proposalFingerprint);
});
