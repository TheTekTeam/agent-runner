import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  DEFAULT_PROJECT_REPOSITORY_INSTRUCTIONS,
  RUNNER_OWN_REPOSITORY,
  RUNNER_OWN_REPOSITORY_INSTRUCTIONS,
  resolveRepositoryContext,
  runnerOwnCheckoutRoot,
} from './agent-runner-repository-context.mjs';

const PROJECT = {
  issueRepository: 'TheTekTeam/modelspend',
  projectRepository: 'TheTekTeam/modelspend',
  projectCheckout: '/home/gp/projects/modelspend-runner-live',
};

test('ordinary same-repository work: no override resolves implementation to the configured project, unchanged', () => {
  const result = resolveRepositoryContext({ ...PROJECT, runnerCheckout: '/home/gp/projects/agent-runner' });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.context, {
    issueRepository: 'TheTekTeam/modelspend',
    projectRepository: 'TheTekTeam/modelspend',
    implementationRepository: 'TheTekTeam/modelspend',
    implementationCheckout: '/home/gp/projects/modelspend-runner-live',
    implementationInstructionPaths: [...DEFAULT_PROJECT_REPOSITORY_INSTRUCTIONS],
  });
});

test('an explicit "Implementation repository:" override selects the runner\'s own repository and checkout', () => {
  const result = resolveRepositoryContext({
    ...PROJECT,
    runnerCheckout: '/home/gp/projects/agent-runner',
    requestedImplementationRepository: RUNNER_OWN_REPOSITORY,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.context.implementationRepository, RUNNER_OWN_REPOSITORY);
  assert.equal(result.context.implementationCheckout, '/home/gp/projects/agent-runner');
  assert.deepEqual(result.context.implementationInstructionPaths, [...RUNNER_OWN_REPOSITORY_INSTRUCTIONS]);
  // issue/project identity must not be overwritten by the implementation override
  assert.equal(result.context.issueRepository, 'TheTekTeam/modelspend');
  assert.equal(result.context.projectRepository, 'TheTekTeam/modelspend');
});

test('an implementation repository not present in the known registry fails closed rather than defaulting silently', () => {
  const result = resolveRepositoryContext({
    ...PROJECT,
    runnerCheckout: '/home/gp/projects/agent-runner',
    requestedImplementationRepository: 'SomeOtherOrg/unrelated-repo',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'implementation-repository-not-recognized');
  assert.equal(result.context, null);
});

test('a malformed implementation repository value fails closed on format, before registry lookup', () => {
  const result = resolveRepositoryContext({
    ...PROJECT,
    runnerCheckout: '/home/gp/projects/agent-runner',
    requestedImplementationRepository: 'not-an-owner-slash-repo',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'implementation-repository-format-invalid');
});

test('a missing project checkout fails closed instead of resolving an empty implementation path', () => {
  const result = resolveRepositoryContext({
    issueRepository: 'TheTekTeam/modelspend',
    projectRepository: 'TheTekTeam/modelspend',
    projectCheckout: '',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.failureReason, 'repository-context-project-checkout-missing');
});

test('an invalid project or issue repository identity fails closed', () => {
  assert.equal(
    resolveRepositoryContext({ ...PROJECT, projectRepository: 'not-owner-slash-repo' }).failureReason,
    'repository-context-project-repository-invalid',
  );
  assert.equal(
    resolveRepositoryContext({ ...PROJECT, issueRepository: '' }).failureReason,
    'repository-context-issue-repository-invalid',
  );
});

test('when the configured project already is the runner repository, the project entry is used without duplication', () => {
  const result = resolveRepositoryContext({
    issueRepository: RUNNER_OWN_REPOSITORY,
    projectRepository: RUNNER_OWN_REPOSITORY,
    projectCheckout: '/home/gp/projects/agent-runner',
    runnerCheckout: '/home/gp/projects/agent-runner',
    requestedImplementationRepository: RUNNER_OWN_REPOSITORY,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.context.implementationCheckout, '/home/gp/projects/agent-runner');
  // Project instruction paths win for this entry (DEFAULT_PROJECT_REPOSITORY_INSTRUCTIONS),
  // since the registry keys on repository identity and the project entry is inserted first.
  assert.deepEqual(result.context.implementationInstructionPaths, [...DEFAULT_PROJECT_REPOSITORY_INSTRUCTIONS]);
});

test('runnerOwnCheckoutRoot resolves two directories up from a scripts/ops/*.mjs script URL', () => {
  const scriptUrl = pathToFileURL('/home/gp/projects/agent-runner/scripts/ops/claude-runner.mjs').href;
  assert.equal(runnerOwnCheckoutRoot(scriptUrl), '/home/gp/projects/agent-runner');
});
