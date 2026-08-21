import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGER_PREFLIGHT_ALREADY_CLAIMED,
  managerAuthorityApprovesAgent,
  parseManagerPreflightPacket,
  resolveCurrentManagerAuthority,
  resolveManagerPreflightExecutionMetadata,
} from './agent-runner-manager-authority.mjs';
import { isValidGitBranchName, resolveDispatchAuthority } from './agent-runner-dispatch-authority.mjs';
import {
  evaluateExecutionAuthorization,
  isGeneratedManagerPreflight,
} from './claude-runner-execution-policy.mjs';
import { renderManagerWorkerAuthorityPacket } from './agent-runner-manager-worker-authority.mjs';
import {
  IMPLEMENTATION_BRANCH,
  READY_ISSUE_NUMBER,
  SOURCE_SHA,
  authorityInput,
  buildAuthority,
  requestInput,
} from './agent-runner-manager-authority-review-test-fixtures.mjs';
import { issueManagerWorkerAuthority } from './agent-runner-manager-worker-authority.mjs';

// The normal bounded machine-local project configuration a dispatch resolution
// is performed against. It is validated config, never issue or comment text.
const PROJECT_CONFIG = Object.freeze({
  githubRepo: 'FixtureOrg/fixture-repo',
  localRepoPath: '/srv/projects/fixture-repo',
});

const authority = buildAuthority();
const packetBody = renderManagerWorkerAuthorityPacket(authority);

function dispatch(body, overrides = {}) {
  return resolveDispatchAuthority({
    preflight: { body },
    config: PROJECT_CONFIG,
    ...overrides,
  });
}

/**
 * The full accepted compatibility chain, in the order a real worker walks it:
 * issue an authority, serialize it, revalidate it with the accepted
 * manager-preflight parser, then resolve it with the accepted dispatch
 * resolver against normal bounded project configuration.
 */
test('a rendered Build Manager authority resolves end to end through the accepted dispatch contract', () => {
  const parsed = parseManagerPreflightPacket(packetBody);
  assert.equal(parsed.valid, true, parsed.detail ?? 'the rendered packet must remain a valid manager preflight');

  const resolution = dispatch(packetBody);
  assert.equal(resolution.ok, true, `dispatch must resolve, got '${resolution.failureReason}'`);
  assert.equal(resolution.failureScope, null);
  assert.equal(resolution.failureReason, null);
  assert.equal(resolution.repository, 'FixtureOrg/fixture-repo');
  assert.equal(resolution.checkout, '/srv/projects/fixture-repo');
  assert.equal(resolution.branch, IMPLEMENTATION_BRANCH);
  assert.equal(resolution.baseCommit, SOURCE_SHA);
  assert.equal(resolution.revision, authority.authorityRevision);
  assert.equal(resolution.fingerprint, authority.authorityFingerprint);

  // The resolved identity is exactly the issued authority, not a re-derivation.
  assert.equal(resolution.repository, authority.repository.full);
  assert.equal(resolution.branch, authority.branch);
  assert.equal(resolution.baseCommit, authority.baseSha);
});

test('approved_repository_scope is emitted as the canonical single-item list', () => {
  assert.match(packetBody, /^approved_repository_scope:\n\s+- "FixtureOrg\/fixture-repo"$/m);
  // Never the scalar form, which parses as a valid preflight and then fails
  // dispatch: that is exactly the defect this regression exists to hold shut.
  assert.doesNotMatch(packetBody, /^approved_repository_scope:[ \t]*\S/m);
});

test('a manually malformed non-list approved_repository_scope is still refused by dispatch', () => {
  // Proves the fix is in the producer, not in a weakened consumer: the
  // accepted resolver still refuses every non-canonical scope shape.
  const scalarForm = packetBody.replace(
    /approved_repository_scope:\n\s+- "FixtureOrg\/fixture-repo"/,
    'approved_repository_scope: FixtureOrg/fixture-repo',
  );
  assert.equal(parseManagerPreflightPacket(scalarForm).valid, true, 'the scalar form still looks like a valid preflight');
  const scalarResolution = dispatch(scalarForm);
  assert.equal(scalarResolution.ok, false);
  assert.equal(scalarResolution.failureReason, 'repository-scope-missing');

  const emptyForm = packetBody.replace(
    /approved_repository_scope:\n\s+- "FixtureOrg\/fixture-repo"/,
    'approved_repository_scope:',
  );
  assert.equal(dispatch(emptyForm).failureReason, 'repository-scope-missing');

  const multipleForm = packetBody.replace(
    /approved_repository_scope:\n\s+- "FixtureOrg\/fixture-repo"/,
    'approved_repository_scope:\n  - "FixtureOrg/fixture-repo"\n  - "OtherOrg/other-repo"',
  );
  assert.equal(dispatch(multipleForm).failureReason, 'repository-scope-multiple');

  const malformedForm = packetBody.replace(
    /approved_repository_scope:\n\s+- "FixtureOrg\/fixture-repo"/,
    'approved_repository_scope:\n  - "not a repository"',
  );
  assert.equal(dispatch(malformedForm).failureReason, 'repository-scope-malformed');
});

test('every branch an authority can bind is a branch the accepted dispatch resolver accepts', () => {
  // The producer narrows the accepted refname rules; it can never widen them.
  const divergent = [
    'agent/trailing-slash/',
    'agent/trailing-dot.',
    'agent/.hidden-segment',
    'agent/nested/.dot',
  ];
  for (const branch of divergent) {
    assert.equal(isValidGitBranchName(branch), false, `${branch} must be an invalid ref for this test to mean anything`);
    assert.throws(
      () => issueManagerWorkerAuthority(authorityInput({ request: requestInput({ branch }) })),
      /one bounded, exact implementation branch name/,
      `issuance must refuse '${branch}' rather than mint an authority dispatch would reject`,
    );
  }

  for (const branch of ['agent/simple', 'agent/nested/branch-1', 'agent/dot.separated']) {
    const issued = issueManagerWorkerAuthority(authorityInput({ request: requestInput({ branch }) })).authority;
    assert.equal(isValidGitBranchName(issued.branch), true);
    const resolution = dispatch(renderManagerWorkerAuthorityPacket(issued));
    assert.equal(resolution.ok, true, `dispatch must accept '${branch}', got '${resolution.failureReason}'`);
    assert.equal(resolution.branch, branch);
  }
});

test('the remaining dispatch-read scalars are each exact and parseable', () => {
  for (const [mutation, expected] of [
    [(body) => body.replace(/^approved_branch: .*$/m, 'approved_branch: bad branch'), 'branch-authority-malformed'],
    [(body) => body.replace(/^approved_branch: .*$/m, 'approved_branch:'), 'branch-authority-missing'],
    [(body) => body.replace(/^base_commit: .*$/m, 'base_commit: deadbeef'), 'base-commit-missing-or-malformed'],
    [(body) => body.replace(/^revision: .*$/m, 'revision:'), 'revision-missing'],
    [(body) => body.replace(/^fingerprint: .*$/m, 'fingerprint: sha256:short'), 'fingerprint-missing-or-malformed'],
  ]) {
    assert.equal(dispatch(mutation(packetBody)).failureReason, expected);
  }
});

test('a conflicting free-form declaration elsewhere in the body still fails dispatch closed', () => {
  assert.equal(
    dispatch(packetBody, { legacyMetadata: { implementation_repository: 'OtherOrg/other-repo' } }).failureReason,
    'repository-scope-legacy-conflict',
  );
  assert.equal(
    dispatch(packetBody, { legacyMetadata: { approved_branch: 'agent/some-other-branch' } }).failureReason,
    'branch-authority-legacy-conflict',
  );
  // The packet's own values never conflict with themselves.
  assert.equal(
    dispatch(packetBody, {
      legacyMetadata: { implementation_repository: 'FixtureOrg/fixture-repo', approved_branch: IMPLEMENTATION_BRANCH },
    }).ok,
    true,
  );
});

test('approved_agent carries the exact adapter the accepted agent check compares', () => {
  const parsed = parseManagerPreflightPacket(packetBody);
  assert.equal(parsed.approvedAgent, authority.adapter);
  assert.equal(managerAuthorityApprovesAgent(parsed, authority.adapter), true);
  assert.equal(managerAuthorityApprovesAgent(parsed, 'some-other-adapter'), false);
  assert.equal(managerAuthorityApprovesAgent(parsed, ''), false);
});

test('profile, model and effort stay compatible with the accepted execution-metadata reader', () => {
  const metadata = resolveManagerPreflightExecutionMetadata(packetBody);
  assert.deepEqual({ ...metadata }, {
    profile: authority.capabilityProfile,
    model: authority.model,
    effort: authority.effort,
  });
});

test('the rendered packet participates in the accepted claim and single-consumption logic', () => {
  const comment = { body: packetBody, created_at: '2026-08-21T00:00:00Z', id: 1 };
  const unclaimed = resolveCurrentManagerAuthority([comment]);
  assert.equal(unclaimed.allowed, true, unclaimed.reason ?? 'a fresh packet must be claimable');
  assert.equal(unclaimed.authority.authorityKey, authority.authorityKey);

  const claimed = resolveCurrentManagerAuthority([
    comment,
    {
      body: `## Claude runner started\n\nManager packet authority: \`${authority.authorityKey}\``,
      created_at: '2026-08-21T00:05:00Z',
      id: 2,
    },
  ]);
  assert.equal(claimed.allowed, false);
  assert.equal(claimed.reason, MANAGER_PREFLIGHT_ALREADY_CLAIMED);
});

test('the new producer type creates no worker-callable execution bypass', () => {
  // The rendered packet is manager-domain output, not runner-generated
  // output, so it correctly carries none of the generated-preflight markers.
  assert.equal(isGeneratedManagerPreflight({ body: packetBody }), false);

  // Execution still depends entirely on the machine-local opt-in and the
  // approved-comment-author allowlist. `producer_type` is not consulted by
  // either gate, so declaring the Build Manager producer changes nothing.
  const preflight = { body: packetBody, user: { login: 'approved-manager' } };
  const blocked = evaluateExecutionAuthorization({ currentPreflight: preflight, profileName: 'complex', env: {} });
  assert.equal(blocked.allowed, false);
  assert.deepEqual([...blocked.violations].sort(), [
    'implementation-requires-machine-opt-in',
    'manager-approver-allowlist-empty',
    'manager-preflight-author-not-allowlisted',
  ]);

  const wrongAuthor = evaluateExecutionAuthorization({
    currentPreflight: { body: packetBody, user: { login: 'some-worker' } },
    profileName: 'complex',
    env: {
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'approved-manager',
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: '1',
    },
  });
  assert.equal(wrongAuthor.allowed, false);
  assert.deepEqual(wrongAuthor.violations, ['manager-preflight-author-not-allowlisted']);

  const allowed = evaluateExecutionAuthorization({
    currentPreflight: preflight,
    profileName: 'complex',
    env: {
      CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'approved-manager',
      CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: '1',
    },
  });
  assert.equal(allowed.allowed, true, allowed.violations.join(', '));
  assert.equal(allowed.phase, 'implementation');
  assert.equal(allowed.preflightApprover, 'approved-manager');
});

test('required_validation and stop_conditions survive the accepted list validation', () => {
  const parsed = parseManagerPreflightPacket(packetBody);
  assert.equal(parsed.valid, true);
  for (const check of authority.validation.requiredChecks) {
    assert.ok(packetBody.includes(`- ${JSON.stringify(check)}`), `${check} must be emitted as a canonical list item`);
  }
  for (const condition of authority.stopConditions) {
    assert.ok(packetBody.includes(`- ${JSON.stringify(condition)}`));
  }
  // Dropping either list makes the packet invalid, proving the accepted
  // parser really is reading these lists from the rendered packet.
  assert.equal(
    parseManagerPreflightPacket(packetBody.replace(/required_validation:\n(?:\s+- .*\n)+/, 'required_validation:\n')).valid,
    false,
  );
  assert.equal(
    parseManagerPreflightPacket(packetBody.replace(/stop_conditions:\n(?:\s+- .*\n)+/, 'stop_conditions:\n')).valid,
    false,
  );
});

test('the issue and curation identity survive serialization for the manager side', () => {
  assert.match(packetBody, new RegExp(`^issue: ${READY_ISSUE_NUMBER}$`, 'm'));
  assert.match(packetBody, new RegExp(`^curation_key: ${authority.curationKey}$`, 'm'));
  assert.match(packetBody, new RegExp(`^curation_fingerprint: ${authority.curationFingerprint}$`, 'm'));
  assert.match(packetBody, new RegExp(`^project_id: ${authority.projectId}$`, 'm'));
});
