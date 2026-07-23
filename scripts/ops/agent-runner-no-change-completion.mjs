export function parseNoChangeCompletionPolicy(markdown = '') {
  const matches = String(markdown || '').split(/\r?\n/)
    .map((line) => line.match(/^\s*No-change completion\s*:\s*(.*?)\s*$/i))
    .filter(Boolean)
    .map((match) => String(match[1] || '').trim().replace(/^`|`$/g, '').trim().toLowerCase());

  if (matches.length === 0) return { explicit: false, allowed: false, reason: 'no-change-completion-not-authorized', value: null };
  if (matches.length !== 1) return { explicit: true, allowed: false, reason: 'no-change-completion-field-ambiguous', value: null };

  const value = matches[0];
  const allowed = value === 'allowed';
  return {
    explicit: true,
    allowed,
    reason: allowed ? 'no-change-completion-explicitly-authorized' : 'no-change-completion-not-authorized',
    value,
  };
}

function unchangedRootEvidence(evidence = {}) {
  const before = evidence.rootBefore;
  const after = evidence.rootAfter;
  return Boolean(before && after)
    && before.head === after.head
    && before.branch === after.branch
    && before.statusFingerprint === after.statusFingerprint
    && Number(before.dirtyEntryCount || 0) === 0
    && Number(after.dirtyEntryCount || 0) === 0;
}

function ownedCleanWorktree(payload = {}, evidence = {}) {
  const expectedBranch = payload.worktreeIdentity?.expectedBranch;
  const worktree = evidence.worktree;
  return Boolean(expectedBranch && worktree)
    && worktree.branch === expectedBranch
    && worktree.head === evidence.baseHead
    && Number(worktree.dirtyEntryCount || 0) === 0;
}

function payloadPreflightRevision(payload = {}) {
  return String(payload.sourcePreflightCommentId || payload.sourcePreflightRevision || '').trim() || null;
}

export function evaluateManagerAuthorizedNoChange({ payload = {}, policy = {}, authority = {} } = {}) {
  const authorityPreflightRevision = authority.preflightCommentRevision || authority.preflightRevision || null;
  const evidence = payload.implementationEvidence || null;
  const failedChecks = [];

  if (authority.allowed !== true || !authorityPreflightRevision) failedChecks.push('pinnedAuthority');
  if (policy.explicit !== true || policy.allowed !== true || policy.value !== 'allowed') failedChecks.push('managerAuthorization');
  if (payloadPreflightRevision(payload) !== authorityPreflightRevision) failedChecks.push('payloadPreflightCorrelation');
  if (payload.executionPhase !== 'implementation') failedChecks.push('implementationPhase');
  if (Number(payload.exitCode) !== 0 || payload.signal) failedChecks.push('successfulProcessExit');
  if (payload.blocked === true || payload.spawnError) failedChecks.push('noProcessBlocker');
  if (payload.executionNoop === true) failedChecks.push('notExecutionNoop');
  if (payload.planProduced === true || payload.awaitingPlanApproval === true) failedChecks.push('notPlanOnly');
  if (payload.failureReason !== 'implementation-no-repository-change') failedChecks.push('expectedNoChangeFailure');
  if (payload.implementationPublication != null) failedChecks.push('noDraftPublication');

  const accounting = payload.usageAccounting || {};
  if (accounting.accountingAvailable !== true || accounting.subtype !== 'success' || accounting.isError !== false) {
    failedChecks.push('successfulAgentEnvelope');
  }

  if (!evidence || evidence.failureReason !== 'implementation-no-repository-change') {
    failedChecks.push('implementationEvidence');
  } else {
    if (evidence.changed !== false || evidence.committed !== false || evidence.clean !== true) failedChecks.push('cleanUnchangedEvidence');
    if (!unchangedRootEvidence(evidence)) failedChecks.push('rootCheckoutUnchanged');
    if (!ownedCleanWorktree(payload, evidence)) failedChecks.push('ownedCleanWorktree');
  }

  if (failedChecks.length > 0) return { accepted: false, reason: 'manager-authorized-no-change-rejected', failedChecks, payload };

  return {
    accepted: true,
    reason: 'manager-authorized-no-change-completed',
    failedChecks: [],
    payload: {
      ...payload,
      failureReason: null,
      implementationEvidence: {
        ...evidence,
        valid: true,
        changed: false,
        committed: false,
        clean: true,
        repositoryMutated: false,
        changedFiles: 0,
        completionKind: 'no-change',
        failureReason: null,
      },
      noChangeCompletion: {
        accepted: true,
        policyRevision: 'manager-authorized-no-change/v1',
        reason: 'validated-existing-state',
        sourcePreflightRevision: authorityPreflightRevision,
        sourcePreflightCommentIdentity: authority.preflightIdentity || null,
        attemptId: authority.attemptId || null,
      },
    },
  };
}
