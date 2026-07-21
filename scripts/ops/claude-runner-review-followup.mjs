// PR review follow-up detection and prompt generation for the Claude runner.
//
// This is reporting/prompt-generation only in v1: it never approves,
// dismisses, or resolves review feedback, and never merges or closes
// anything. It only tells the runner (and the operator) whether an open PR
// has unresolved manager/reviewer feedback and, if so, builds a follow-up
// Claude prompt scoped to that feedback.

const LINKED_ISSUE_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;

function latestReviewStatePerAuthor(reviews = []) {
  const latestByAuthor = new Map();
  for (const review of reviews) {
    const author = review?.user?.login || review?.author?.login || review?.author || 'unknown';
    const submittedAt = review?.submitted_at || review?.submittedAt || review?.createdAt || null;
    const existing = latestByAuthor.get(author);
    if (!existing || new Date(submittedAt || 0) >= new Date(existing.submittedAt || 0)) {
      latestByAuthor.set(author, { author, state: review?.state || null, body: review?.body || '', submittedAt });
    }
  }
  return [...latestByAuthor.values()];
}

/**
 * Determine whether a PR has unresolved review/manager feedback that should
 * block new issue work and warrant a follow-up Claude run.
 *
 * Primary signal is GitHub's own review state (a reviewer's most recent
 * review is CHANGES_REQUESTED) plus any explicitly unresolved review threads.
 * Comment text is collected as supporting context for the prompt but is not
 * itself the trigger, to avoid false positives on casual conversation.
 */
export function detectUnresolvedReviewFollowUp({ reviews = [], reviewThreads = [], comments = [] } = {}) {
  const latestReviews = latestReviewStatePerAuthor(reviews);
  const changesRequested = latestReviews.filter((review) => review.state === 'CHANGES_REQUESTED');
  const unresolvedThreads = (reviewThreads || []).filter((thread) => thread && thread.isResolved === false);

  const hasUnresolvedFollowUp = changesRequested.length > 0 || unresolvedThreads.length > 0;
  const reasons = [];
  if (changesRequested.length > 0) reasons.push(`changes-requested:${changesRequested.map((r) => r.author).join(',')}`);
  if (unresolvedThreads.length > 0) reasons.push(`unresolved-review-threads:${unresolvedThreads.length}`);

  const unresolvedComments = [
    ...changesRequested.map((review) => ({ source: 'review', author: review.author, body: review.body, createdAt: review.submittedAt })),
    ...unresolvedThreads.flatMap((thread) => (thread.comments || []).map((comment) => ({
      source: 'review-thread',
      author: comment?.user?.login || comment?.author?.login || comment?.author || 'unknown',
      body: comment?.body || '',
      createdAt: comment?.created_at || comment?.createdAt || null,
    }))),
  ];

  const recentManagerComments = (comments || [])
    .filter((comment) => /manager/i.test(comment?.user?.login || comment?.author?.login || comment?.author || ''))
    .map((comment) => ({
      source: 'issue-comment',
      author: comment?.user?.login || comment?.author?.login || comment?.author || 'unknown',
      body: comment?.body || '',
      createdAt: comment?.created_at || comment?.createdAt || null,
    }));

  return {
    hasUnresolvedFollowUp,
    reasons,
    unresolvedComments: [...unresolvedComments, ...recentManagerComments],
  };
}

export function linkedIssueNumberFromPr({ body = '', title = '' } = {}) {
  const combined = `${title}\n${body}`;
  let match;
  let latest = null;
  LINKED_ISSUE_PATTERN.lastIndex = 0;
  while ((match = LINKED_ISSUE_PATTERN.exec(combined)) !== null) {
    latest = Number.parseInt(match[1], 10);
  }
  return latest;
}

/**
 * Find open PRs plausibly linked to an issue, from an already-fetched list of
 * open PRs. Matching is intentionally conservative (explicit close/fix
 * keyword, or a branch name ending in the issue number) to avoid pulling in
 * unrelated PRs.
 */
export function findLinkedOpenPullRequests({ issueNumber, pullRequests = [] } = {}) {
  if (!issueNumber) return [];
  const branchSuffix = new RegExp(`(^|[-/])${issueNumber}$`);
  return pullRequests.filter((pr) => {
    const linked = linkedIssueNumberFromPr({ body: pr.body, title: pr.title });
    if (linked === issueNumber) return true;
    const headRef = pr.headRefName || pr.head_ref_name || '';
    return branchSuffix.test(headRef);
  });
}

export function buildReviewFollowUpPrompt({ pr, issueNumber = null, branch, unresolved, repo = null }) {
  const commentList = (unresolved.unresolvedComments || [])
    .map((comment, index) => `${index + 1}. [${comment.source}] ${comment.author} (${comment.createdAt || 'unknown time'}):\n   ${String(comment.body || '').trim().replace(/\n/g, '\n   ')}`)
    .join('\n\n') || '(no comment bodies captured — check the PR review tab directly)';
  const identityLine = repo ? `You are Claude Code CLI working on ${repo}.` : 'You are Claude Code CLI working on this repository.';

  return `${identityLine}\n\nThis is a PR review follow-up run, not a new task.\n\nPR: #${pr.number} — ${pr.title}\nURL: ${pr.url || ''}\nLinked issue: ${issueNumber ? `#${issueNumber}` : 'unknown — check the PR body'}\nBranch: ${branch}\n\nUnresolved review/manager feedback triggering this run:\n${unresolved.reasons.join(', ') || 'unresolved review state detected'}\n\nUnresolved comments:\n\n${commentList}\n\nRunner rules for this follow-up run:\n- Stay on branch \`${branch}\`. Do not create a new branch.\n- Address only the unresolved review/manager feedback listed above.\n- Do not start unrelated work, refactors, or scope expansion.\n- Rerun the validation the PR requires (see docs/claude/VALIDATION-GATES.md) after making changes.\n- Do not merge, approve, or close anything yourself. A human merge gate remains mandatory.\n- Report exactly which unresolved comments were addressed and which (if any) still need human input.\n`;
}
