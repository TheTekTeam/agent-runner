// PR review follow-up detection and prompt generation for the Claude runner.
//
// This is reporting/prompt-generation only in v1: it never approves,
// dismisses, or resolves review feedback, and never merges or closes
// anything. It only tells the runner (and the operator) whether an open PR
// has unresolved manager/reviewer feedback and, if so, builds a follow-up
// Claude prompt scoped to that feedback.

// Include "implements" because publishImplementationDraft() uses exactly
// `Implements #N ...` for runner-created draft PRs. Without this, a valid
// runner PR whose approved branch does not end in the issue number can become
// unlinkable to direct PR continuation even though the runner itself created
// the linkage text.
const LINKED_ISSUE_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|implement(?:s|ed|ing)?)\s*:?\s*#(\d+)/gi;

/**
 * #242: which review authors may supply *executable* correction input.
 *
 * Detection/reporting (the accepted #188 semantics) stays deliberately wide:
 * any unresolved thread still blocks new issue work, because a conservative
 * block is always safe. Execution is the opposite -- a write-capable provider
 * run under someone else's manager authority must not be triggerable by an
 * arbitrary GitHub account that can comment on a public PR. GitHub's own
 * author association is the existing, already-authoritative signal for "this
 * person has write standing on this repository", so it is reused here rather
 * than inventing a parallel allowlist.
 */
export const TRUSTED_REVIEW_AUTHOR_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function reviewAuthorAssociation(record) {
  const raw = record?.authorAssociation ?? record?.author_association ?? null;
  return raw === null || raw === undefined ? null : String(raw).toUpperCase();
}

export function isTrustedReviewAuthor(record) {
  return TRUSTED_REVIEW_AUTHOR_ASSOCIATIONS.includes(reviewAuthorAssociation(record) || '');
}

function latestReviewStatePerAuthor(reviews = []) {
  const latestByAuthor = new Map();
  for (const review of reviews) {
    const author = review?.user?.login || review?.author?.login || review?.author || 'unknown';
    const submittedAt = review?.submitted_at || review?.submittedAt || review?.createdAt || null;
    const existing = latestByAuthor.get(author);
    if (!existing || new Date(submittedAt || 0) >= new Date(existing.submittedAt || 0)) {
      latestByAuthor.set(author, {
        author,
        state: review?.state || null,
        body: review?.body || '',
        submittedAt,
        authorAssociation: reviewAuthorAssociation(review),
      });
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
      authorAssociation: reviewAuthorAssociation(comment),
    }))),
  ];

  const recentManagerComments = (comments || [])
    .filter((comment) => /manager/i.test(comment?.user?.login || comment?.author?.login || comment?.author || ''))
    .map((comment) => ({
      source: 'issue-comment',
      author: comment?.user?.login || comment?.author?.login || comment?.author || 'unknown',
      body: comment?.body || '',
      createdAt: comment?.created_at || comment?.createdAt || null,
      authorAssociation: reviewAuthorAssociation(comment),
    }));

  return {
    hasUnresolvedFollowUp,
    reasons,
    unresolvedComments: [...unresolvedComments, ...recentManagerComments],
  };
}

// A single continuation prompt must stay bounded regardless of how much
// review conversation a PR accumulated. These caps are applied on top of the
// per-comment truncation the GraphQL reader already performs.
export const MAX_EXECUTABLE_REVIEW_INSTRUCTIONS = 20;
export const MAX_EXECUTABLE_REVIEW_INSTRUCTION_CHARS = 2000;

export const REVIEW_FEEDBACK_NONE = 'pr-continuation-no-unresolved-review-instruction';
export const REVIEW_FEEDBACK_UNTRUSTED = 'pr-continuation-review-authors-untrusted';

function boundInstructionBody(body) {
  const text = String(body || '').trim();
  if (text.length <= MAX_EXECUTABLE_REVIEW_INSTRUCTION_CHARS) return text;
  const marker = '… [truncated]';
  return `${text.slice(0, Math.max(0, MAX_EXECUTABLE_REVIEW_INSTRUCTION_CHARS - marker.length))}${marker}`;
}

/**
 * #242: select the review feedback a write-capable continuation is allowed to
 * act on.
 *
 * Only two GitHub-authoritative signals qualify: an unresolved review thread,
 * or a reviewer whose latest review state is CHANGES_REQUESTED. Both must come
 * from an author with write standing (see TRUSTED_REVIEW_AUTHOR_ASSOCIATIONS).
 * Issue-comment chatter is never executable input -- it is reporting context
 * only -- so it is deliberately excluded here even though
 * `detectUnresolvedReviewFollowUp` still surfaces it.
 *
 * Fails closed with a distinct reason when unresolved feedback exists but no
 * part of it is trusted, so the refusal is truthful about *why* rather than
 * looking like "nothing to do".
 */
export function selectExecutableReviewFeedback({ reviews = [], reviewThreads = [] } = {}) {
  const unresolvedThreads = (reviewThreads || []).filter((thread) => thread && thread.isResolved === false);
  const changesRequested = latestReviewStatePerAuthor(reviews).filter((review) => review.state === 'CHANGES_REQUESTED');

  const candidates = [
    ...changesRequested.map((review) => ({
      source: 'review',
      threadId: null,
      author: review.author,
      authorAssociation: review.authorAssociation,
      body: review.body,
      createdAt: review.submittedAt,
    })),
    ...unresolvedThreads.flatMap((thread) => (thread.comments || []).map((comment) => ({
      source: 'review-thread',
      threadId: thread.id || null,
      author: comment?.user?.login || comment?.author?.login || comment?.author || 'unknown',
      authorAssociation: reviewAuthorAssociation(comment),
      body: comment?.body || '',
      createdAt: comment?.created_at || comment?.createdAt || null,
    }))),
  ].filter((candidate) => String(candidate.body || '').trim().length > 0);

  if (candidates.length === 0) {
    return Object.freeze({
      executable: false,
      failureReason: REVIEW_FEEDBACK_NONE,
      instructions: Object.freeze([]),
      rejectedAuthorCount: 0,
      unresolvedThreadIds: Object.freeze(unresolvedThreads.map((thread) => thread.id || null).filter(Boolean)),
    });
  }

  const trusted = candidates.filter((candidate) => isTrustedReviewAuthor(candidate));
  if (trusted.length === 0) {
    return Object.freeze({
      executable: false,
      failureReason: REVIEW_FEEDBACK_UNTRUSTED,
      instructions: Object.freeze([]),
      rejectedAuthorCount: candidates.length,
      unresolvedThreadIds: Object.freeze(unresolvedThreads.map((thread) => thread.id || null).filter(Boolean)),
    });
  }

  const instructions = trusted
    .slice(0, MAX_EXECUTABLE_REVIEW_INSTRUCTIONS)
    .map((candidate) => Object.freeze({ ...candidate, body: boundInstructionBody(candidate.body) }));

  return Object.freeze({
    executable: true,
    failureReason: null,
    instructions: Object.freeze(instructions),
    rejectedAuthorCount: candidates.length - trusted.length,
    truncatedInstructionCount: Math.max(0, trusted.length - instructions.length),
    unresolvedThreadIds: Object.freeze(unresolvedThreads.map((thread) => thread.id || null).filter(Boolean)),
  });
}

/**
 * Render selected feedback as the continuation prompt's mutable evidence.
 * Deterministic and side-effect free so the dynamic-suffix fingerprint is
 * reproducible for identical feedback (#193/#248).
 */
export function renderExecutableReviewInstructions(instructions = []) {
  if (!instructions.length) return '(no executable review feedback captured)';
  return instructions
    .map((instruction, index) => [
      `${index + 1}. [${instruction.source}] ${instruction.author} (${instruction.authorAssociation || 'unknown association'}, ${instruction.createdAt || 'unknown time'}):`,
      `   ${String(instruction.body || '').replace(/\n/g, '\n   ')}`,
    ].join('\n'))
    .join('\n\n');
}

/**
 * Return every distinct issue number explicitly linked through the accepted
 * close/fix/resolve keywords or the runner's own deterministic `Implements`
 * publication wording, preserving appearance order. Direct PR continuation
 * admission needs the full set so more than one linked issue can fail closed
 * instead of silently inheriting linkedIssueNumberFromPr()'s historical
 * "latest wins" reporting behavior.
 */
export function linkedIssueNumbersFromPr({ body = '', title = '' } = {}) {
  const combined = `${title}\n${body}`;
  const numbers = [];
  const seen = new Set();
  let match;
  LINKED_ISSUE_PATTERN.lastIndex = 0;
  while ((match = LINKED_ISSUE_PATTERN.exec(combined)) !== null) {
    const issueNumber = Number.parseInt(match[1], 10);
    if (Number.isInteger(issueNumber) && issueNumber > 0 && !seen.has(issueNumber)) {
      seen.add(issueNumber);
      numbers.push(issueNumber);
    }
  }
  return numbers;
}

export function linkedIssueNumberFromPr(input = {}) {
  const numbers = linkedIssueNumbersFromPr(input);
  return numbers.length > 0 ? numbers[numbers.length - 1] : null;
}

/**
 * Find open PRs plausibly linked to an issue, from an already-fetched list of
 * open PRs. Matching is intentionally conservative (explicit linkage
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
