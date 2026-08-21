#!/usr/bin/env node

/**
 * #266: deterministic test-support fixtures for the queue-curation family.
 * This module is not part of the runtime queue-curation path: it only builds
 * the validated profile -> evidence -> brief -> proposal -> queue-evidence
 * chain the focused tests need, using the same public validators production
 * callers use. It performs no GitHub call, no provider invocation and no
 * mutation.
 */

import { MANAGER_PLAN_PROPOSAL_SCHEMA_VERSION, validateManagerPlanProposal } from './agent-runner-manager-plan-proposal.mjs';
import { MANAGER_PROFILE_SCHEMA_VERSION, validateManagerProfile } from './agent-runner-manager-profile-schema.mjs';
import { MANAGER_PROJECT_BRIEF_SCHEMA_VERSION, validateManagerProjectBrief } from './agent-runner-manager-project-brief.mjs';
import { MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION, validateManagerProjectEvidence } from './agent-runner-manager-project-evidence.mjs';
import { MANAGER_QUEUE_EVIDENCE_SCHEMA_VERSION, validateManagerQueueEvidence } from './agent-runner-manager-queue-evidence.mjs';

export const SOURCE_SHA = 'a'.repeat(40);
export const OTHER_SOURCE_SHA = 'c'.repeat(40);
export const DOC_SHA = 'b'.repeat(64);
export const HEAD_SHA = 'd'.repeat(40);

export const LABELS = Object.freeze({
  ready: 'status:ready',
  inProgress: 'status:in-progress',
  blocked: 'status:blocked',
  done: 'status:done',
});

export function profileInput(overrides = {}) {
  return {
    schemaVersion: MANAGER_PROFILE_SCHEMA_VERSION,
    projectId: 'fixture-project',
    enabled: true,
    repository: { owner: 'FixtureOrg', name: 'fixture-repo' },
    branches: { allowed: ['main'], default: 'main' },
    objective: 'Keep the fixture project queue curated deterministically.',
    nonGoals: ['Worker authority issuance'],
    instructionPaths: ['AGENTS.md'],
    controlIssue: { mode: 'fixedIssue', issueNumber: 100 },
    labels: { ...LABELS },
    capabilities: { allowlist: ['fixture-adapter'] },
    validation: { profile: 'complex', requiredChecks: ['npm test', 'npm run validate'] },
    quotaPolicyRef: 'fixture#quota-only-admission',
    mutationBounds: { maxIssueMutationsPerRecurrence: 10, maxCommentsPerRecurrence: 2 },
    escalation: { rules: ['Stop and report if evidence is ambiguous'] },
    mutationAuthority: {
      issueMutation: true,
      authorityIssuance: true,
      merge: false,
      close: false,
      deploy: false,
      sourceActivation: false,
    },
    ...overrides,
  };
}

export function buildProfile(overrides = {}) {
  return validateManagerProfile(profileInput(overrides));
}

export function buildEvidence(profile, overrides = {}) {
  return validateManagerProjectEvidence({
    schemaVersion: MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION,
    projectId: profile.projectId,
    repository: { owner: profile.repository.owner, name: profile.repository.name },
    branch: profile.branches.default,
    sourceSha: SOURCE_SHA,
    evidenceRevision: 'evidence-2026-08-21.1',
    evidenceTimestamp: '2026-08-21T00:00:00Z',
    instructionDocuments: profile.instructionPaths.map((path) => ({ path, sha256: DOC_SHA, freshness: 'current' })),
    tooling: {
      languages: ['javascript'], packageManagers: ['npm'], buildTools: ['node'], workflows: ['github-actions'],
    },
    acceptanceCommands: [profile.validation.requiredChecks[0]],
    openIssues: [],
    openPullRequests: [],
    ...overrides,
  }, { profile });
}

export function buildBrief(evidence) {
  return validateManagerProjectBrief({
    schemaVersion: MANAGER_PROJECT_BRIEF_SCHEMA_VERSION,
    objective: 'Curate the project queue from a validated plan.',
    outcome: 'Bounded queue records reflect the accepted plan.',
    constraints: ['One registered project only'],
    nonGoals: ['Worker authority issuance', 'Provider execution'],
    architectureSummary: 'Node.js modules under scripts/ops validated with node:test.',
    risks: ['Queue evidence could go stale between recurrences'],
    assumptions: ['Evidence was collected at the exact accepted source revision'],
    blockers: [],
    escalationQuestions: ['Which proposed work is a product decision?'],
    definitionOfDone: ['Focused tests pass', 'Repository validation passes'],
  }, { evidence });
}

/**
 * Two milestones: `foundation` has no dependencies and `curation` depends on
 * it, so every `curation` issue depends on every `foundation` issue.
 */
export function proposalInput(brief, overrides = {}) {
  return {
    schemaVersion: MANAGER_PLAN_PROPOSAL_SCHEMA_VERSION,
    grounding: { repository: brief.repository, branch: brief.branch, sourceSha: brief.sourceSha },
    milestones: [
      { id: 'foundation', title: 'Foundation', description: 'Bounded evidence contract.', dependsOn: [] },
      { id: 'curation', title: 'Curation', description: 'Deterministic curation transition.', dependsOn: ['foundation'] },
    ],
    proposedIssues: [
      {
        id: 'evidence-contract',
        milestoneId: 'foundation',
        title: 'Bounded queue evidence contract',
        scope: 'Validate and normalize the bounded current-queue evidence snapshot.',
        acceptanceCriteria: ['Unknown fields are refused', 'Identity is bound to one registered project'],
        decisionType: 'implementation',
      },
      {
        id: 'curator-transition',
        milestoneId: 'curation',
        title: 'Deterministic curation transition',
        scope: 'Turn validated evidence into a bounded dry-run curation proposal.',
        acceptanceCriteria: ['Identical input yields an identical fingerprint'],
        decisionType: 'implementation',
      },
    ],
    blockers: [],
    escalations: [],
    ...overrides,
  };
}

export function buildProposal(brief, overrides = {}) {
  return validateManagerPlanProposal(proposalInput(brief, overrides), { brief });
}

export function buildChain({ profileOverrides = {}, proposalOverrides = {} } = {}) {
  const profile = buildProfile(profileOverrides);
  const evidence = buildEvidence(profile);
  const brief = buildBrief(evidence);
  const proposal = buildProposal(brief, proposalOverrides);
  return { profile, evidence, brief, proposal };
}

export function queueEvidenceInput(proposal, overrides = {}) {
  return {
    schemaVersion: MANAGER_QUEUE_EVIDENCE_SCHEMA_VERSION,
    projectId: proposal.projectId,
    repository: {
      owner: proposal.brief.evidence.repository.owner,
      name: proposal.brief.evidence.repository.name,
    },
    branch: proposal.branch,
    sourceSha: proposal.sourceSha,
    evidenceRevision: 'queue-2026-08-21.1',
    evidenceTimestamp: '2026-08-21T00:05:00Z',
    issues: [],
    ownership: { activeLeases: [], openPullRequests: [] },
    ...overrides,
  };
}

export function buildQueueEvidence(proposal, overrides = {}) {
  return validateManagerQueueEvidence(queueEvidenceInput(proposal, overrides), { proposal });
}
