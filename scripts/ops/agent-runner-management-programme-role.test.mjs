import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRoleCapabilities } from './agent-runner-management-control-mode.mjs';
import { runProgrammeReconciliation } from './agent-runner-management-programme-role.mjs';
import {
  LABELS,
  PROJECT_ID,
  REPOSITORY,
  SOURCE_SHA,
  T0,
  buildAuthority,
  curationWith,
  portFactory,
  programmeEvidence,
} from './agent-runner-management-test-fixtures.mjs';

const EVENT = Object.freeze({
  eventId: 'management-programme-1',
  eventType: 'programme-reconcile-required',
  projectId: PROJECT_ID,
  repository: REPOSITORY,
  correlationId: 'correlation-1',
  causalDepth: 0,
});

const BOTH_ISSUES = Object.freeze([
  { number: 501, title: 'Bounded queue evidence contract', state: 'open', labels: [LABELS.ready], curationKey: 'qc:fixture-project:evidence-contract' },
  { number: 502, title: 'Deterministic curation transition', state: 'open', labels: [LABELS.blocked], curationKey: 'qc:fixture-project:curator-transition', dependsOn: [501] },
]);

function runProgramme({ mode = 'active', evidence = programmeEvidence(), event = EVENT, calls } = {}) {
  const recorded = calls ?? { queueMutation: [], workerAuthority: [], continuation: [], appliedOperations: [] };
  const { resolvePorts } = portFactory({ programme: evidence, calls: recorded });
  const ports = resolvePorts({ role: 'programme' });
  const collected = ports.collectEvidence();
  const capabilities = resolveRoleCapabilities({
    role: 'programme', mode, ports: { ...ports, collectEvidence: () => collected },
  });
  return { result: runProgrammeReconciliation({ event, capabilities, now: T0 }), calls: recorded };
}

test('a clean reconciliation with a ready record issues exactly one worker authority', () => {
  const { result, calls } = runProgramme({ evidence: programmeEvidence({ curation: curationWith({ issues: BOTH_ISSUES }) }) });
  assert.equal(result.outcome, 'execution-required');
  assert.equal(result.reason, 'authority-issued');
  assert.equal(calls.workerAuthority.length, 1);
  assert.equal(result.identity.issueNumber, 501);
  assert.equal(result.identity.sha, SOURCE_SHA);
});

test('the successor is an identity-only execution reconciliation, never an instruction', () => {
  const { result } = runProgramme({ evidence: programmeEvidence({ curation: curationWith({ issues: BOTH_ISSUES }) }) });
  assert.equal(result.successors.length, 1);
  const [successor] = result.successors;
  assert.equal(successor.eventType, 'execution-reconcile-required');
  assert.equal(successor.issueNumber, 501);
  assert.deepEqual(Object.keys(successor).sort(), ['correlationId', 'eventType', 'issueNumber', 'notBefore', 'pullRequestNumber', 'sha']);
});

test('planner and curator integration is visible in the projection counts', () => {
  const { result } = runProgramme({ evidence: programmeEvidence({ curation: curationWith({ issues: BOTH_ISSUES }) }) });
  // One ready foundation record, one dependency-blocked curation record.
  assert.equal(result.projection.counts.ready, 1);
  assert.equal(result.projection.counts.blocked, 1);
  assert.equal(result.projection.milestones.length, 2);
  assert.equal(result.projection.criticalPath.length, 2);
  assert.match(result.projection.planRevision, /^qcr:[a-f0-9]{32}$/);
});

test('active mode applies the bounded queue mutation through the accepted boundary', () => {
  const { result, calls } = runProgramme();
  assert.equal(calls.queueMutation.length, 1);
  assert.deepEqual(calls.appliedOperations.map((entry) => entry.kind), ['create-issue', 'update-labels']);
  assert.equal(result.mutationSuppressed, false);
});

test('shadow mode computes the dry run but applies nothing and publishes nothing', () => {
  const { result, calls } = runProgramme({ mode: 'shadow' });
  assert.equal(calls.queueMutation.length, 0);
  assert.equal(calls.appliedOperations.length, 0);
  assert.equal(calls.workerAuthority.length, 0);
  assert.equal(result.mutationSuppressed, true);
  // The decision is still computed, which is exactly the comparison evidence
  // shadow mode exists to produce.
  assert.equal(result.outcome, 'execution-required');
});

test('a no-op curation with no candidate request is quiescent and emits no successor', () => {
  const { result } = runProgramme({
    evidence: programmeEvidence({ curation: curationWith({ issues: BOTH_ISSUES }), candidateRequests: [] }),
  });
  assert.equal(result.outcome, 'quiescent');
  assert.equal(result.reason, 'no-runnable-work');
  assert.equal(result.successors.length, 0);
  assert.equal(result.projection.lifecycleState, 'quiescent');
});

test('a queue change with no runnable work asks for independent assurance', () => {
  const { result } = runProgramme({ evidence: programmeEvidence({ candidateRequests: [] }) });
  assert.equal(result.outcome, 'assurance-required');
  assert.equal(result.reason, 'queue-changed-no-runnable-work');
  assert.deepEqual(result.successors.map((entry) => entry.eventType), ['queue-assurance-required']);
});

/** A live ledger entry for the ready record, as a granted authority leaves. */
function liveLedger(issueNumber = 501) {
  const authority = buildAuthority();
  return {
    issued: [{
      authorityKey: authority.authorityKey,
      authorityFingerprint: authority.authorityFingerprint,
      issueNumber,
      branch: authority.branch,
      baseSha: authority.baseSha,
      state: 'issued',
    }],
  };
}

test('an occupied slot attributed to one live authority wakes execution with exact identity', () => {
  const { result, calls } = runProgramme({
    evidence: programmeEvidence({
      implementationSlot: { state: 'occupied', occupied: true },
      authorityLedger: liveLedger(501),
    }),
  });
  assert.equal(result.outcome, 'execution-required');
  assert.equal(result.reason, 'implementation-slot-occupied');
  assert.equal(calls.workerAuthority.length, 0, 'nothing new is authorised while the slot is held');
  const execution = result.successors.find((entry) => entry.eventType === 'execution-reconcile-required');
  // The successor names the attempt, so the execution collector can resolve it
  // rather than refusing it as ambiguous.
  assert.equal(execution.issueNumber, 501);
});

test('an occupied slot this project cannot attribute never emits an unresolvable execution wake', () => {
  const { result, calls } = runProgramme({
    // Occupied, but this project has granted nothing: the slot belongs to
    // another registered project or to work outside the control plane.
    evidence: programmeEvidence({ implementationSlot: { state: 'occupied', occupied: true } }),
  });
  assert.equal(result.outcome, 'delayed-retry');
  assert.equal(result.reason, 'implementation-slot-owned-elsewhere');
  assert.equal(calls.workerAuthority.length, 0);
  assert.equal(result.successors.some((entry) => entry.eventType === 'execution-reconcile-required'), false);
  assert.ok(Date.parse(result.successors[0].notBefore) > Date.parse(T0));
});

test('an occupied slot with more than one live owner is handed to the read-only auditor', () => {
  const authority = buildAuthority();
  const { result } = runProgramme({
    evidence: programmeEvidence({
      implementationSlot: { state: 'occupied', occupied: true },
      authorityLedger: {
        issued: [
          {
            authorityKey: authority.authorityKey,
            authorityFingerprint: authority.authorityFingerprint,
            issueNumber: 501,
            branch: authority.branch,
            baseSha: authority.baseSha,
            state: 'issued',
          },
          {
            authorityKey: 'mwa:another-live-authority',
            authorityFingerprint: `sha256:${'7'.repeat(64)}`,
            issueNumber: 502,
            branch: 'agent/other-502',
            baseSha: SOURCE_SHA,
            state: 'issued',
          },
        ],
      },
    }),
  });
  assert.equal(result.outcome, 'assurance-required');
  assert.equal(result.reason, 'implementation-slot-owner-ambiguous');
  assert.deepEqual(result.successors.map((entry) => entry.eventType), ['queue-assurance-required']);
});

test('an unprovable slot state blocks new authority rather than admitting one', () => {
  const { result, calls } = runProgramme({
    evidence: programmeEvidence({ implementationSlot: { state: 'ambiguous', occupied: false } }),
  });
  assert.equal(result.outcome, 'delayed-retry');
  assert.equal(result.reason, 'implementation-slot-ambiguous');
  assert.equal(calls.workerAuthority.length, 0);
});

test('an active ownership collision defers with a bounded delayed retry', () => {
  const curation = curationWith({
    ownership: { activeLeases: [{ issueNumber: 501, kind: 'implementation', holder: 'worker-1' }], openPullRequests: [] },
  });
  const { result, calls } = runProgramme({ evidence: programmeEvidence({ curation }) });
  assert.equal(result.outcome, 'delayed-retry');
  assert.equal(result.reason, 'active-ownership-collision');
  assert.equal(calls.workerAuthority.length, 0);
  const [successor] = result.successors;
  assert.equal(successor.eventType, 'programme-reconcile-required');
  assert.ok(Date.parse(successor.notBefore) > Date.parse(T0), 'the retry must be delayed');
});

test('quota headroom is the only admission gate and both refusals fail closed', () => {
  for (const [state, reason] of [['unavailable', 'quota-unavailable'], ['ambiguous', 'quota-ambiguous']]) {
    const { result, calls } = runProgramme({
      evidence: programmeEvidence({
        curation: curationWith({ issues: BOTH_ISSUES }),
        quotaAdmission: { state, profileName: 'complex' },
      }),
    });
    assert.equal(result.outcome, 'delayed-retry', state);
    assert.equal(result.reason, reason);
    assert.equal(calls.workerAuthority.length, 0, 'no authority may be issued without quota headroom');
    assert.ok(Date.parse(result.successors[0].notBefore) > Date.parse(T0));
  }
});

test('a duplicate authority is an idempotent no-op rather than a second grant', () => {
  const authority = buildAuthority();
  const { result, calls } = runProgramme({
    evidence: programmeEvidence({
      authorityLedger: {
        issued: [{
          authorityKey: authority.authorityKey,
          authorityFingerprint: authority.authorityFingerprint,
          issueNumber: authority.issueNumber,
          branch: authority.branch,
          baseSha: authority.baseSha,
          state: 'issued',
        }],
      },
    }),
  });
  assert.equal(result.outcome, 'execution-required');
  assert.equal(result.reason, 'authority-duplicate-no-op');
  // The duplicate is never re-published: that would be a second grant of ownership.
  assert.equal(calls.workerAuthority.length, 0);
});

test('a genuine plan escalation becomes owner attention and deliberately emits no successor', () => {
  const { result, calls } = runProgramme({
    evidence: programmeEvidence({
      curation: curationWith({ proposalOverrides: { escalations: ['A product owner must confirm the intended queue scope.'] } }),
    }),
  });
  assert.equal(result.outcome, 'owner-attention');
  assert.equal(result.reason, 'owner-decision-outstanding');
  // A programme event whose only successor is another programme event would be
  // a self-loop no re-read could resolve.
  assert.equal(result.successors.length, 0);
  assert.equal(result.projection.ownerAttentionRequired, true);
  assert.equal(calls.workerAuthority.length, 0);
});

test('the role fails closed on a project or repository the event was not raised for', () => {
  assert.throws(
    () => runProgramme({ event: { ...EVENT, projectId: 'second-project' } }),
    /but the event is for 'second-project'/,
  );
  assert.throws(
    () => runProgramme({ event: { ...EVENT, repository: 'FixtureOrg/second-repo' } }),
    /but the event is for 'FixtureOrg\/second-repo'/,
  );
});

test('the role fails closed on a base commit that has moved underneath the curation', () => {
  assert.throws(
    () => runProgramme({ evidence: programmeEvidence({ sourceSha: 'c'.repeat(40) }) }),
    /curation was computed at source revision .* but the current source revision is/,
  );
  // With nothing to mutate the same staleness is caught by authority issuance,
  // so a moved base can never produce an authority either.
  assert.throws(
    () => runProgramme({
      evidence: programmeEvidence({ curation: curationWith({ issues: BOTH_ISSUES }), sourceSha: 'c'.repeat(40) }),
    }),
    /no longer matches the accepted base/,
  );
});

test('collected evidence must be a validated queue-evidence snapshot, never a look-alike', () => {
  assert.throws(
    () => runProgramme({ evidence: programmeEvidence({ queueEvidence: Object.freeze({ projectId: PROJECT_ID }) }) }),
    /was not produced by validateManagerQueueEvidence/,
  );
  assert.throws(
    () => runProgramme({ evidence: { ...programmeEvidence(), unexpectedField: true } }),
    /unsupported field\(s\): unexpectedField/,
  );
});

test('the programme role is never given a capability to consume the authority it issues', () => {
  const { resolvePorts } = portFactory();
  const ports = resolvePorts({ role: 'programme' });
  const capabilities = resolveRoleCapabilities({ role: 'programme', mode: 'active', ports });
  for (const name of ['consumeWorkerAuthority', 'dispatchWorker', 'merge', 'closeIssue', 'activateSource']) {
    assert.equal(name in capabilities.ports, false, name);
  }
});
