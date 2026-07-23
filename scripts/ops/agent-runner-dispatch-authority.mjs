import { resolveRepositoryContext } from './agent-runner-repository-context.mjs';

// The pre-claim dispatch-resolution boundary (#56). A canonical immutable
// manager packet (#43/PR #55) is already the sole new-claim authority for
// *whether* an issue may be claimed at all; this module is the single place
// that resolves *what repository/checkout/branch/base-commit that claim
// implements*, so the same packet cannot be honoured for admission while a
// different repository or generated branch is used for the actual work
// (the exact #40 dispatch defect this issue exists to close).
//
// `approved_repository_scope` and `approved_branch` are read only from the
// fenced YAML block of the already-marker-validated manager packet comment
// -- never from free-form prose elsewhere in the body. Legacy/free-form
// `key: value` lines (parsed generically by callers via
// `parseKeyValueBlock` in claude-runner.mjs, including
// `implementation_repository`) are accepted only as read-only compatibility
// evidence; any disagreement with the canonical YAML fields fails closed.

export const DISPATCH_FAILURE_SCOPE = Object.freeze({
  ISSUE_NOT_RUNNABLE: 'issue_not_runnable',
  SYSTEMIC: 'systemic',
});

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const TOP_LEVEL_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/;

function yamlBlocks(body = '') {
  return [...String(body || '').matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)].map((match) => match[1]);
}

function canonicalScalar(body, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `[ \t]*`, not `\s*`, around the colon -- `\s` includes `\n`, so a
  // greedy `\s*` on an empty-valued line (`key: ` with nothing following)
  // would consume the line break itself and let the lazy capture group
  // run on into the *next* line's content instead of stopping at this
  // line's end.
  const pattern = new RegExp(`^[ \\t]*${escaped}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`, 'm');
  for (const block of yamlBlocks(body)) {
    const match = block.match(pattern);
    if (match) {
      const value = String(match[1] || '').trim().replace(/^["']|["']$/g, '');
      return { present: true, value: value || null };
    }
  }
  return { present: false, value: null };
}

function canonicalList(body, key) {
  for (const block of yamlBlocks(body)) {
    const lines = block.split(/\r?\n/);
    let found = false;
    let active = false;
    const values = [];
    for (const line of lines) {
      const topLevel = line.match(TOP_LEVEL_KEY_PATTERN);
      if (topLevel) {
        active = topLevel[1] === key;
        if (active) found = true;
        continue;
      }
      if (active) {
        const item = line.match(/^\s+-\s+(.*\S)\s*$/)?.[1];
        if (item !== undefined) values.push(item.trim().replace(/^["']|["']$/g, ''));
      }
    }
    if (found) return { present: true, values };
  }
  return { present: false, values: [] };
}

/**
 * git-check-ref-format's core rules, applied without a git subprocess so
 * this resolver stays a pure, side-effect-free function callable during
 * admission (no model call, no claim, no GitHub/workspace mutation).
 */
export function isValidGitBranchName(value) {
  const name = String(value || '');
  if (!name) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('//')) return false;
  if (name.includes('..')) return false;
  if (/[\s~^:?*[\]\\\x00-\x1f\x7f]/.test(name)) return false;
  if (name.endsWith('.lock') || name.endsWith('.')) return false;
  if (name.split('/').some((segment) => segment === '' || segment.startsWith('.'))) return false;
  if (name.includes('@{') || name === '@') return false;
  return true;
}

function fail(failureScope, failureReason) {
  return Object.freeze({
    ok: false,
    failureScope,
    failureReason,
    repository: null,
    checkout: null,
    branch: null,
    baseCommit: null,
    revision: null,
    fingerprint: null,
  });
}

/**
 * Resolve and verify implementation repository, checkout, branch, base
 * commit, manager revision and manager fingerprint from one canonical
 * manager-preflight packet comment. Returns `{ ok: false, failureScope,
 * failureReason }` on any missing, malformed, multiple, or contradictory
 * authority -- never a partial/best-guess resolution.
 *
 * This function performs no I/O beyond the pure repository-context lookup
 * (`resolveRepositoryContext`, itself a pure registry lookup over already
 * validated machine-local config): no git commands, no GitHub calls, no
 * model invocation. It is safe to call during admission, before any claim,
 * attempt, or mutation exists.
 */
export function resolveDispatchAuthority({
  preflight,
  legacyMetadata = {},
  argsRepo,
  config = {},
  runnerCheckout,
} = {}) {
  const body = preflight?.body || '';

  const repositoryScope = canonicalList(body, 'approved_repository_scope');
  if (!repositoryScope.present || repositoryScope.values.length === 0) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'repository-scope-missing');
  }
  if (repositoryScope.values.length > 1) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'repository-scope-multiple');
  }
  const [canonicalRepository] = repositoryScope.values;
  if (!REPO_PATTERN.test(canonicalRepository)) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'repository-scope-malformed');
  }
  const legacyRepository = String(legacyMetadata.implementation_repository || '').trim() || null;
  if (legacyRepository && legacyRepository !== canonicalRepository) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'repository-scope-legacy-conflict');
  }

  const branchScalar = canonicalScalar(body, 'approved_branch');
  if (!branchScalar.present || !branchScalar.value) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'branch-authority-missing');
  }
  const approvedBranch = branchScalar.value;
  if (!isValidGitBranchName(approvedBranch)) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'branch-authority-malformed');
  }
  // `legacyMetadata.approved_branch` is the same generic free-form
  // `key: value` scan already used for `implementation_repository`
  // (claude-runner.mjs's `parseKeyValueBlock`), which -- unlike
  // `canonicalScalar` above -- matches any line in the body, not only the
  // fenced YAML packet. In the well-formed case it echoes the same YAML
  // line, so it only ever disagrees when a second, non-canonical
  // declaration exists elsewhere in the comment.
  const legacyBranch = String(legacyMetadata.approved_branch || '').trim() || null;
  if (legacyBranch && legacyBranch !== approvedBranch) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'branch-authority-legacy-conflict');
  }

  const baseCommitScalar = canonicalScalar(body, 'base_commit');
  if (!baseCommitScalar.present || !COMMIT_PATTERN.test(baseCommitScalar.value || '')) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'base-commit-missing-or-malformed');
  }

  const revisionScalar = canonicalScalar(body, 'revision');
  if (!revisionScalar.present || !revisionScalar.value) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'revision-missing');
  }

  const fingerprintScalar = canonicalScalar(body, 'fingerprint');
  if (!fingerprintScalar.present || !FINGERPRINT_PATTERN.test(fingerprintScalar.value || '')) {
    return fail(DISPATCH_FAILURE_SCOPE.ISSUE_NOT_RUNNABLE, 'fingerprint-missing-or-malformed');
  }

  const repositoryContextResult = resolveRepositoryContext({
    issueRepository: argsRepo || canonicalRepository,
    projectRepository: config.githubRepo,
    projectCheckout: config.localRepoPath,
    runnerCheckout,
    requestedImplementationRepository: canonicalRepository,
  });
  if (!repositoryContextResult.allowed) {
    // A well-formed, unambiguous canonical repository that no machine-local
    // configuration recognises is a configuration gap, not a defect in this
    // issue's packet content -- it would block every issue naming this
    // repository, not only this one.
    return fail(DISPATCH_FAILURE_SCOPE.SYSTEMIC, repositoryContextResult.failureReason);
  }

  return Object.freeze({
    ok: true,
    failureScope: null,
    failureReason: null,
    repository: canonicalRepository,
    checkout: repositoryContextResult.context.implementationCheckout,
    branch: approvedBranch,
    baseCommit: baseCommitScalar.value,
    revision: revisionScalar.value,
    fingerprint: fingerprintScalar.value.toLowerCase(),
  });
}
