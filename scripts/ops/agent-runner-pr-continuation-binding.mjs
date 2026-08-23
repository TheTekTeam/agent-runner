import { resolveManagerContinuationAuthority } from './agent-runner-manager-continuation-authority.mjs';
import { linkedIssueNumbersFromPr } from './claude-runner-review-followup.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function fail(failureReason, details = {}) {
  return Object.freeze({
    allowed: false,
    failureReason,
    ...details,
  });
}

function boundedAuthorityEvidence(resolved) {
  const authority = resolved?.authority;
  return authority ? Object.freeze({
    authorityKey: authority.authorityKey || null,
    revision: authority.revision || null,
    fingerprint: authority.fingerprint || null,
    packetDigest: authority.packetDigest || null,
    alreadyClaimed: resolved.alreadyClaimed === true,
  }) : null;
}

function pullRequestHeadIdentity(pullRequest = {}) {
  const repository = pullRequest?.head?.repo?.full_name || null;
  const branch = pullRequest?.head?.ref || null;
  const sha = pullRequest?.head?.sha || null;
  return Object.freeze({ repository, branch, sha });
}

/**
 * #241: bind one reviewed PR to the exact linked issue authority and the
 * existing runner-owned continuation worktree before any provider launch.
 *
 * The GitHub read itself remains a caller responsibility. This function only
 * consumes already-fetched PR/issue/comments plus the runner's accepted
 * dispatch/worktree helpers, injected explicitly so this module does not
 * duplicate their identity logic or create a circular import back into
 * claude-runner.mjs. It never creates/reset/cleans a worktree and has no
 * provider/GitHub mutation surface.
 */
export function resolvePrContinuationBinding({
  pullRequest,
  issue,
  issueComments = [],
  repo,
  config = {},
  env = process.env,
  runner,
  resolveDispatchIdentity,
  prepareWorkspace,
  captureEvidence,
  verifyRecoveryCheckpoint = null,
} = {}) {
  if (!pullRequest || !issue) {
    return fail('pr-continuation-input-missing');
  }
  if (
    typeof resolveDispatchIdentity !== 'function'
    || typeof prepareWorkspace !== 'function'
    || typeof captureEvidence !== 'function'
  ) {
    return fail('pr-continuation-binding-dependency-missing');
  }
  if (pullRequest.state !== 'open') {
    return fail('pr-continuation-pr-not-open');
  }
  if (!Number.isInteger(pullRequest.number) || pullRequest.number <= 0) {
    return fail('pr-continuation-pr-number-invalid');
  }

  const linkedIssueNumbers = linkedIssueNumbersFromPr({
    title: pullRequest.title || '',
    body: pullRequest.body || '',
  });
  if (linkedIssueNumbers.length === 0) {
    return fail('pr-continuation-linked-issue-missing');
  }
  if (linkedIssueNumbers.length !== 1) {
    return fail('pr-continuation-linked-issue-ambiguous', {
      linkedIssueNumbers: Object.freeze([...linkedIssueNumbers]),
    });
  }
  const linkedIssueNumber = linkedIssueNumbers[0];
  if (!Number.isInteger(issue.number) || issue.number !== linkedIssueNumber) {
    return fail('pr-continuation-linked-issue-mismatch', { linkedIssueNumber });
  }

  const continuationAuthority = resolveManagerContinuationAuthority(issueComments);
  if (!continuationAuthority.allowed || !continuationAuthority.authority) {
    return fail('pr-continuation-manager-authority-refused', {
      authorityReason: continuationAuthority.reason || null,
      authorityDetail: continuationAuthority.detail || null,
    });
  }

  const dispatchIdentity = resolveDispatchIdentity({
    issue,
    command: null,
    currentPreflight: continuationAuthority.authority.comment,
    config,
    env,
    argsRepo: repo,
  });
  if (!dispatchIdentity?.ok) {
    return fail(dispatchIdentity?.failureReason || 'pr-continuation-dispatch-identity-refused', {
      failureScope: dispatchIdentity?.failureScope || null,
    });
  }
  if (
    dispatchIdentity.executionAuthorization?.allowed !== true
    || dispatchIdentity.executionAuthorization?.phase !== 'implementation'
  ) {
    return fail('pr-continuation-execution-authorization-refused');
  }
  if (!dispatchIdentity.worktreeIdentity?.expectedBranch) {
    return fail('pr-continuation-worktree-identity-missing');
  }

  const head = pullRequestHeadIdentity(pullRequest);
  if (!head.repository || !head.branch || !SHA_PATTERN.test(String(head.sha || ''))) {
    return fail('pr-continuation-pr-head-identity-missing');
  }
  const authorisedRepository = dispatchIdentity.dispatchAuthority?.repository || null;
  const authorisedBranch = dispatchIdentity.dispatchAuthority?.branch || null;
  if (!authorisedRepository || head.repository !== authorisedRepository) {
    return fail('pr-continuation-pr-repository-mismatch', {
      expectedRepository: authorisedRepository,
      observedRepository: head.repository,
    });
  }
  if (!authorisedBranch || head.branch !== authorisedBranch) {
    return fail('pr-continuation-pr-branch-mismatch', {
      expectedBranch: authorisedBranch,
      observedBranch: head.branch,
    });
  }
  if (dispatchIdentity.worktreeIdentity.expectedBranch !== authorisedBranch) {
    return fail('pr-continuation-worktree-authority-mismatch');
  }

  const workspace = prepareWorkspace({
    worktreeIdentity: dispatchIdentity.worktreeIdentity,
    implementationCheckout: dispatchIdentity.repositoryContext?.implementationCheckout,
    env,
    runner,
  });
  if (workspace?.allowed !== true) {
    return fail(workspace?.failureReason || 'pr-continuation-workspace-refused');
  }
  if (workspace.baseHead !== head.sha) {
    return fail('pr-continuation-pr-head-worktree-mismatch', {
      expectedHeadSha: head.sha,
      observedHeadSha: workspace.baseHead || null,
    });
  }

  // prepareContinuationWorkspace deliberately supports dirty recovery
  // checkpoints. PR review continuation is stricter: it must start from the
  // exact clean published PR head. Re-read evidence here rather than changing
  // the shared recovery helper's semantics.
  const worktreeEvidence = captureEvidence({
    cwd: workspace.worktreePath,
    includeUntracked: true,
    runner,
  });
  if (!worktreeEvidence) {
    return fail('pr-continuation-worktree-evidence-unavailable');
  }
  if (worktreeEvidence.branch !== authorisedBranch) {
    return fail('pr-continuation-worktree-branch-mismatch', {
      expectedBranch: authorisedBranch,
      observedBranch: worktreeEvidence.branch || null,
    });
  }
  if (worktreeEvidence.head !== head.sha) {
    return fail('pr-continuation-pr-head-worktree-mismatch', {
      expectedHeadSha: head.sha,
      observedHeadSha: worktreeEvidence.head || null,
    });
  }
  // #242 defect 4: a *failed* continuation (for example a worker that edited
  // but never committed) leaves this worktree dirty, which the clean-start
  // rule above would then refuse forever -- permanently dead-ending the PR
  // and pushing the operator toward resetting/discarding real work.
  //
  // The safe recovery model is neither "reset it" nor "trust any dirt": the
  // dirt is admissible only when it is provably the *exact* preserved
  // checkpoint the previous failed continuation recorded for this same
  // repository, PR, branch and published head, byte-identical by status
  // fingerprint. Any unrelated modification changes that fingerprint and
  // fails closed here, and work is never destroyed either way.
  let recoveredCheckpoint = null;
  if (worktreeEvidence.dirtyEntryCount !== 0) {
    const recovery = typeof verifyRecoveryCheckpoint === 'function'
      ? verifyRecoveryCheckpoint({
        repository: authorisedRepository,
        prNumber: pullRequest.number,
        branch: authorisedBranch,
        headSha: head.sha,
        worktreeIdentity: dispatchIdentity.worktreeIdentity,
        rootPath: workspace.rootPath || null,
        worktreePath: workspace.worktreePath || null,
        statusFingerprint: worktreeEvidence.statusFingerprint || null,
        dirtyEntryCount: worktreeEvidence.dirtyEntryCount,
      })
      : null;
    if (recovery?.recoverable !== true) {
      return fail('pr-continuation-worktree-dirty', {
        dirtyEntryCount: worktreeEvidence.dirtyEntryCount,
        statusFingerprint: worktreeEvidence.statusFingerprint || null,
        recoveryFailureReason: recovery?.failureReason || 'pr-continuation-no-preserved-checkpoint',
      });
    }
    recoveredCheckpoint = Object.freeze({
      recovered: true,
      checkpointHead: head.sha,
      checkpointStatusFingerprint: worktreeEvidence.statusFingerprint || null,
      dirtyEntryCount: worktreeEvidence.dirtyEntryCount,
      handleDigest: recovery.handleDigest || null,
    });
  }

  return Object.freeze({
    allowed: true,
    failureReason: null,
    issueNumber: linkedIssueNumber,
    prNumber: pullRequest.number,
    repository: authorisedRepository,
    branch: authorisedBranch,
    preRunHeadSha: head.sha,
    authority: boundedAuthorityEvidence(continuationAuthority),
    profileName: dispatchIdentity.profileName || null,
    managerExecutionMeta: dispatchIdentity.managerExecutionMeta || null,
    executionAuthorization: dispatchIdentity.executionAuthorization,
    repositoryContext: dispatchIdentity.repositoryContext,
    dispatchAuthority: dispatchIdentity.dispatchAuthority,
    worktreeIdentity: dispatchIdentity.worktreeIdentity,
    workspace: Object.freeze({
      baseRef: workspace.baseRef || null,
      baseHead: workspace.baseHead || null,
      rootPath: workspace.rootPath || null,
      worktreePath: workspace.worktreePath || null,
      workspacePreparedByRunner: workspace.workspacePreparedByRunner === true,
    }),
    worktreeEvidence: Object.freeze({
      head: worktreeEvidence.head,
      branch: worktreeEvidence.branch,
      dirtyEntryCount: worktreeEvidence.dirtyEntryCount,
      statusFingerprint: worktreeEvidence.statusFingerprint || null,
    }),
    recoveredCheckpoint,
  });
}
