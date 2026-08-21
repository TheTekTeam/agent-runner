import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNormalizedManagerQueueEvidenceShape,
  MANAGER_QUEUE_EVIDENCE_SCHEMA_VERSION,
  normalizeQueueTitle,
  queueCurationKey,
  validateManagerQueueEvidence,
} from './agent-runner-manager-queue-evidence.mjs';
import {
  buildChain,
  buildQueueEvidence,
  HEAD_SHA,
  OTHER_SOURCE_SHA,
  queueEvidenceInput,
} from './agent-runner-manager-queue-test-fixtures.mjs';

const { proposal } = buildChain();

function refusal(overrides, expected) {
  assert.throws(
    () => validateManagerQueueEvidence(queueEvidenceInput(proposal, overrides), { proposal }),
    (error) => {
      assert.match(error.message, /^Invalid agent runner manager queue evidence: /);
      assert.match(error.message, expected);
      return true;
    },
  );
}

test('a bounded current-queue snapshot normalizes deterministically', () => {
  const queueEvidence = buildQueueEvidence(proposal, {
    issues: [
      {
        number: 12,
        title: '  Deterministic   curation   transition ',
        state: 'open',
        labels: ['status:blocked', 'priority:p0'],
        curationKey: 'qc:fixture-project:curator-transition',
        dependsOn: [11],
      },
      { number: 11, title: 'Bounded queue evidence contract', state: 'closed', labels: ['status:done'] },
    ],
    ownership: { activeLeases: [], openPullRequests: [{ number: 40, issueNumber: 12, headSha: HEAD_SHA }] },
  });

  assert.equal(queueEvidence.schemaVersion, MANAGER_QUEUE_EVIDENCE_SCHEMA_VERSION);
  // Issues, labels and dependencies are all sorted, so incidental GitHub
  // ordering can never change the snapshot or its fingerprint.
  assert.deepEqual(queueEvidence.issues.map((issue) => issue.number), [11, 12]);
  assert.deepEqual(queueEvidence.issues[1].labels, ['priority:p0', 'status:blocked']);
  assert.equal(queueEvidence.issues[1].title, 'Deterministic   curation   transition');
  assert.equal(normalizeQueueTitle(queueEvidence.issues[1].title), 'deterministic curation transition');
  assert.match(queueEvidence.queueEvidenceFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotThrow(() => assertNormalizedManagerQueueEvidenceShape(queueEvidence));
});

test('identical queue evidence input yields an identical fingerprint', () => {
  const first = buildQueueEvidence(proposal, { issues: [{ number: 3, title: 'One', state: 'open' }] });
  const second = buildQueueEvidence(proposal, { issues: [{ number: 3, title: 'One', state: 'open' }] });
  assert.equal(first.queueEvidenceFingerprint, second.queueEvidenceFingerprint);
});

test('a differently ordered but semantically identical snapshot fingerprints identically', () => {
  const ordered = buildQueueEvidence(proposal, {
    issues: [
      { number: 1, title: 'One', state: 'open', labels: ['a:one', 'b:two'] },
      { number: 2, title: 'Two', state: 'open', labels: [] },
    ],
  });
  const shuffled = buildQueueEvidence(proposal, {
    issues: [
      { number: 2, title: 'Two', state: 'open', labels: [] },
      { number: 1, title: 'One', state: 'open', labels: ['b:two', 'a:one'] },
    ],
  });
  assert.equal(ordered.queueEvidenceFingerprint, shuffled.queueEvidenceFingerprint);
});

test('queue evidence requires an already-validated plan proposal', () => {
  const forged = { ...proposal };
  assert.throws(
    () => validateManagerQueueEvidence(queueEvidenceInput(proposal), { proposal: Object.freeze(forged) }),
    /was not produced by validateManagerPlanProposal/,
  );
});

test('an unknown top-level field is refused', () => {
  refusal({ unexpected: true }, /queueEvidence\.unexpected is not a recognised field/);
});

test('an unknown issue field is refused', () => {
  refusal(
    { issues: [{ number: 1, title: 'One', state: 'open', assignee: 'someone' }] },
    /issues\[0\]\.assignee is not a recognised field/,
  );
});

test('a repository that does not match the proposal is refused', () => {
  refusal({ repository: { owner: 'OtherOrg', name: 'fixture-repo' } }, /repository must exactly match the proposal repository/);
});

test('a branch that does not match the proposal is refused', () => {
  refusal({ branch: 'release' }, /branch must exactly match the proposal branch/);
});

test('a source revision that does not match the proposal is refused', () => {
  refusal({ sourceSha: OTHER_SOURCE_SHA }, /sourceSha must exactly match the proposal sourceSha/);
});

test('a malformed project identity is refused', () => {
  refusal({ projectId: 'some-other-project' }, /projectId must exactly match the proposal projectId/);
});

test('an oversized issue title is refused', () => {
  refusal({ issues: [{ number: 1, title: 'x'.repeat(400), state: 'open' }] }, /issues\[0\]\.title must be at most 200 characters/);
});

test('a machine-local path in an issue title is refused', () => {
  refusal({ issues: [{ number: 1, title: 'Fix /home/gp/secret.json handling', state: 'open' }] }, /must not contain a local-machine path/);
});

test('a credential-shaped issue title is refused', () => {
  refusal(
    { issues: [{ number: 1, title: 'rotate ghp_abcdefghijklmnopqrstuvwxyz0123 now', state: 'open' }] },
    /must not contain a secret or credential-shaped token/,
  );
});

test('a shell payload in an issue title is refused', () => {
  refusal({ issues: [{ number: 1, title: 'run $(rm -rf everything)', state: 'open' }] }, /must not contain a shell command or executable payload/);
});

test('duplicate issue numbers are refused', () => {
  refusal(
    { issues: [{ number: 5, title: 'One', state: 'open' }, { number: 5, title: 'Two', state: 'open' }] },
    /issues\[1\]\.number duplicates an already-listed issue/,
  );
});

test('two issues claiming the same curation key are refused', () => {
  refusal(
    {
      issues: [
        { number: 5, title: 'One', state: 'open', curationKey: 'qc:fixture-project:evidence-contract' },
        { number: 6, title: 'Two', state: 'open', curationKey: 'qc:fixture-project:evidence-contract' },
      ],
    },
    /duplicates curation key 'qc:fixture-project:evidence-contract'/,
  );
});

test('a malformed curation key is refused', () => {
  refusal(
    { issues: [{ number: 5, title: 'One', state: 'open', curationKey: 'not-a-curation-key' }] },
    /curationKey must be a bounded "qc:<projectId>:<proposedIssueId>" key/,
  );
});

test('a dependency on an issue outside this project queue is refused', () => {
  refusal(
    { issues: [{ number: 5, title: 'One', state: 'open', dependsOn: [999] }] },
    /issue 5 depends on issue 999, which is not present in this project's queue evidence/,
  );
});

test('an explicitly cross-project dependency reference is refused', () => {
  refusal(
    { issues: [{ number: 5, title: 'One', state: 'open', dependsOn: ['OtherOrg/other-repo#3'] }] },
    /references repository 'OtherOrg\/other-repo' outside the registered project repository/,
  );
});

test('a same-repository qualified dependency reference is accepted and normalized', () => {
  const queueEvidence = buildQueueEvidence(proposal, {
    issues: [
      { number: 5, title: 'One', state: 'open', dependsOn: ['FixtureOrg/fixture-repo#4'] },
      { number: 4, title: 'Two', state: 'open' },
    ],
  });
  assert.deepEqual(queueEvidence.issues.find((issue) => issue.number === 5).dependsOn, [4]);
});

test('a self-referential dependency is refused', () => {
  refusal({ issues: [{ number: 5, title: 'One', state: 'open', dependsOn: [5] }] }, /must not depend on the issue itself/);
});

test('a dangling supersession target is refused', () => {
  refusal(
    { issues: [{ number: 5, title: 'One', state: 'open', supersededBy: 77 }] },
    /is superseded by issue 77, which is not present in this project's queue evidence/,
  );
});

test('a supersession cycle is refused', () => {
  refusal(
    {
      issues: [
        { number: 5, title: 'One', state: 'open', supersededBy: 6 },
        { number: 6, title: 'Two', state: 'open', supersededBy: 5 },
      ],
    },
    /participates in a supersession cycle/,
  );
});

test('two active implementation leases violate the one-global-implementation-slot invariant', () => {
  refusal(
    {
      issues: [
        { number: 5, title: 'One', state: 'open' },
        { number: 6, title: 'Two', state: 'open' },
      ],
      ownership: {
        activeLeases: [
          { issueNumber: 5, kind: 'implementation', holder: 'runner-a' },
          { issueNumber: 6, kind: 'implementation', holder: 'runner-b' },
        ],
        openPullRequests: [],
      },
    },
    /one-global-implementation-slot invariant is violated: 2 active implementation leases/,
  );
});

test('an issue held by both implementation and recovery ownership is refused', () => {
  refusal(
    {
      issues: [{ number: 5, title: 'One', state: 'open' }],
      ownership: {
        activeLeases: [
          { issueNumber: 5, kind: 'implementation', holder: 'runner-a' },
          { issueNumber: 5, kind: 'recovery', holder: 'recovery-a' },
        ],
        openPullRequests: [],
      },
    },
    /is held by both an implementation and a recovery lease/,
  );
});

test('a lease on an unknown issue is refused', () => {
  refusal(
    {
      issues: [{ number: 5, title: 'One', state: 'open' }],
      ownership: { activeLeases: [{ issueNumber: 9, kind: 'implementation', holder: 'runner-a' }], openPullRequests: [] },
    },
    /activeLeases references issue 9, which is not present/,
  );
});

test('a lease on a closed issue is refused as synthetic state', () => {
  refusal(
    {
      issues: [{ number: 5, title: 'One', state: 'closed' }],
      ownership: { activeLeases: [{ issueNumber: 5, kind: 'implementation', holder: 'runner-a' }], openPullRequests: [] },
    },
    /issue 5 is closed but still holds an active implementation lease/,
  );
});

test('a lease on a superseded issue is refused as synthetic state', () => {
  refusal(
    {
      issues: [
        { number: 5, title: 'One', state: 'open', supersededBy: 6 },
        { number: 6, title: 'Two', state: 'open' },
      ],
      ownership: { activeLeases: [{ issueNumber: 5, kind: 'recovery', holder: 'recovery-a' }], openPullRequests: [] },
    },
    /issue 5 is superseded but still holds an active recovery lease/,
  );
});

test('an open pull request against an unknown issue is refused', () => {
  refusal(
    {
      issues: [{ number: 5, title: 'One', state: 'open' }],
      ownership: { activeLeases: [], openPullRequests: [{ number: 40, issueNumber: 9 }] },
    },
    /openPullRequests references issue 9, which is not present/,
  );
});

test('an unsupported lease kind is refused', () => {
  refusal(
    {
      issues: [{ number: 5, title: 'One', state: 'open' }],
      ownership: { activeLeases: [{ issueNumber: 5, kind: 'deployment', holder: 'runner-a' }], openPullRequests: [] },
    },
    /kind must be one of implementation, recovery/,
  );
});

test('an unsupported issue state is refused', () => {
  refusal({ issues: [{ number: 5, title: 'One', state: 'merged' }] }, /state must be one of open, closed/);
});

test('queueCurationKey is deterministic and rejects unsafe tokens', () => {
  assert.equal(queueCurationKey('fixture-project', 'evidence-contract'), 'qc:fixture-project:evidence-contract');
  assert.throws(() => queueCurationKey('Fixture Project', 'evidence-contract'), /safe lowercase project id token/);
  assert.throws(() => queueCurationKey('fixture-project', 'Evidence Contract'), /safe lowercase proposed issue id token/);
});
