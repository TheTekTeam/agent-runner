#!/usr/bin/env node

// Shared issue-selection helpers for the Claude runner (Agent Runner v2).
//
// Both scripts/ops/claude-runner-cron.mjs (queue scan/claim) and
// scripts/ops/claude-runner.mjs (prompt/dispatch) need the same view of
// "what Claude command or manager preflight packet applies to this issue".
// Extracting that logic here avoids duplicated/circular command-parsing and
// manager-preflight-detection code across the two entry points.

import {
  commentRevision,
  normalizeCommentIdentity,
  sameCommentIdentity,
} from './claude-runner-comment-identity.mjs';

export const STATUS_READY = 'status:ready';
export const STATUS_IN_PROGRESS = 'status:in-progress';
export const RUNNER_STARTED_HEADING = '## Claude runner started';
export const CLAUDE_COMMAND_HEADINGS = {
  proceed: '## Claude proceed command',
  continue: '## Claude continue command',
};

export function commentTime(comment) {
  return comment?.created_at || comment?.createdAt || '1970-01-01T00:00:00Z';
}

export function commentId(comment) {
  return commentRevision(comment);
}

export function findLastMarkdownHeadingIndex(body = '', heading = '') {
  const text = String(body || '');
  let latest = -1;
  let offset = 0;
  for (const segment of text.split(/(?<=\n)/)) {
    const line = segment.replace(/\r?\n$/, '');
    if (line.trimEnd() === heading) latest = offset;
    offset += segment.length;
  }
  return latest;
}

export function findLatestClaudeCommand(comments = [], kinds = ['proceed', 'continue']) {
  const headings = kinds.map((kind) => [kind, CLAUDE_COMMAND_HEADINGS[kind]]).filter(([, heading]) => heading);
  const sorted = [...comments].sort((a, b) => new Date(commentTime(a)) - new Date(commentTime(b)));
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const body = sorted[i]?.body || '';
    let best = null;
    for (const [kind, heading] of headings) {
      const index = findLastMarkdownHeadingIndex(body, heading);
      if (index !== -1 && (!best || index > best.index)) best = { kind, heading, index };
    }
    if (best) {
      const sourceCommentIdentity = normalizeCommentIdentity(sorted[i]);
      return {
        kind: best.kind,
        heading: best.heading,
        body: body.slice(best.index).trim(),
        sourceCommentIdentity,
        sourceCommentRevision: commentRevision(sourceCommentIdentity),
        // Compatibility field; the value is now explicitly typed by its
        // `github-comment:*` prefix and is never a raw generic `id`.
        sourceCommentId: commentRevision(sourceCommentIdentity),
        createdAt: commentTime(sorted[i]),
        authorLogin: sorted[i]?.user?.login || sorted[i]?.author?.login || sorted[i]?.authorLogin || null,
      };
    }
  }
  return null;
}

export function findLatestClaudeProceedCommand(comments = []) {
  return findLatestClaudeCommand(comments, ['proceed']);
}

export function findLatestClaudeContinueCommand(comments = []) {
  return findLatestClaudeCommand(comments, ['continue']);
}

export function invalidatesManagerPreflight(commandText = '') {
  const value = String(commandText || '');
  return /^#{2,4}\s*(?:Manager|ChatGPT)\s+preflight(?:\s+packet)?\s*(?:[-—:]\s*)?(?:stale|invalid(?:ated)?|revoked|superseded)\b/im.test(value);
}

export function hasManagerPreflight(commandText = '') {
  const value = String(commandText || '');
  if (invalidatesManagerPreflight(value)) return false;
  return /^#{2,4}\s*Manager\s+preflight\s+packet\b/im.test(value)
    || /^#{2,4}\s*ChatGPT\s+preflight(?:\s+packet)?\b/im.test(value)
    || /preflight\s+(?:prepared|completed|run)\s+by\s+(?:ChatGPT|manager)/i.test(value);
}

export function latestManagerPreflightComment(comments = []) {
  const sorted = [...comments]
    .sort((left, right) => String(commentTime(right)).localeCompare(String(commentTime(left))));

  for (const comment of sorted) {
    const body = comment?.body || '';
    if (invalidatesManagerPreflight(body)) return null;
    if (hasManagerPreflight(body)) return comment;
  }
  return null;
}

export function commandAlreadyClaimed(comments = [], command) {
  if (!command?.sourceCommentIdentity) return false;
  const commandCreatedAt = new Date(command.createdAt || 0).getTime();
  return comments.some((comment) => {
    const body = comment?.body || '';
    const createdAt = new Date(commentTime(comment)).getTime();
    const markerRevision = body.match(/Source command comment:\s*(\S+)/)?.[1] || null;
    return createdAt > commandCreatedAt
      && body.includes(RUNNER_STARTED_HEADING)
      && sameCommentIdentity(markerRevision, command.sourceCommentIdentity);
  });
}

export function preflightAlreadyClaimed(comments = [], preflight) {
  const preflightIdentity = normalizeCommentIdentity(preflight);
  if (!preflightIdentity) return false;
  const preflightCreatedAt = new Date(commentTime(preflight)).getTime();
  return comments.some((comment) => {
    const body = comment?.body || '';
    const createdAt = new Date(commentTime(comment)).getTime();
    const markerRevision = body.match(/Source preflight comment:\s*(\S+)/)?.[1] || null;
    return createdAt > preflightCreatedAt
      && body.includes(RUNNER_STARTED_HEADING)
      && sameCommentIdentity(markerRevision, preflightIdentity);
  });
}

/**
 * Compatibility-mode command check: is there a runnable (unclaimed,
 * manager-preflighted) proceed/continue command on this issue? Unchanged
 * from the pre-v2 selector so proceed-command mode keeps working exactly as
 * before.
 */
export function runnableCommandForIssue(issue, comments = [], { requireManagerPreflight = true } = {}) {
  if (issue.statusLabel === STATUS_READY) {
    const command = findLatestClaudeCommand(comments, ['proceed']);
    if (!command) return { command: null, reason: 'missing proceed command' };
    if (!command.sourceCommentIdentity) return { command: null, reason: 'proceed command comment identity unavailable' };
    if (commandAlreadyClaimed(comments, command)) return { command: null, reason: 'proceed command already claimed' };
    if (requireManagerPreflight) {
      const preflight = latestManagerPreflightComment(comments);
      if (!preflight) return { command: null, reason: 'missing manager preflight packet' };
      if (!normalizeCommentIdentity(preflight)) return { command: null, reason: 'manager preflight comment identity unavailable' };
    }
    return { command, reason: null };
  }

  if (issue.statusLabel === STATUS_IN_PROGRESS) {
    const command = findLatestClaudeCommand(comments, ['continue']);
    if (!command) return { command: null, reason: 'missing continue command' };
    if (!command.sourceCommentIdentity) return { command: null, reason: 'continue command comment identity unavailable' };
    if (commandAlreadyClaimed(comments, command)) return { command: null, reason: 'continue command already claimed' };
    if (requireManagerPreflight) {
      const preflight = latestManagerPreflightComment(comments);
      if (!preflight) return { command: null, reason: 'missing manager preflight packet' };
      if (!normalizeCommentIdentity(preflight)) return { command: null, reason: 'manager preflight comment identity unavailable' };
    }
    return { command, reason: null };
  }

  return { command: null, reason: `unsupported status label ${issue.statusLabel || 'unknown'}` };
}

/**
 * Agent Runner v2 dual-dispatch selection. Tries the compatibility
 * proceed/continue command path first (unchanged behaviour); if a
 * status:ready issue has no proceed command but does have an unclaimed
 * manager preflight packet, selects it directly in `preflight-direct` mode
 * instead of skipping with "missing proceed command".
 */
export function resolveIssueSelection(issue, comments = [], { requireManagerPreflight = true, preflightDirectMode = true } = {}) {
  const { command, reason } = runnableCommandForIssue(issue, comments, { requireManagerPreflight });
  if (command) return { mode: 'proceed-command', command, preflight: null, reason: null };

  if (reason === 'missing proceed command' && issue.statusLabel === STATUS_READY && preflightDirectMode) {
    const preflight = latestManagerPreflightComment(comments);
    if (!preflight) return { mode: null, command: null, preflight: null, reason: 'missing manager preflight packet' };
    if (!normalizeCommentIdentity(preflight)) return { mode: null, command: null, preflight: null, reason: 'manager preflight comment identity unavailable' };
    if (preflightAlreadyClaimed(comments, preflight)) return { mode: null, command: null, preflight: null, reason: 'preflight already claimed' };
    return { mode: 'preflight-direct', command: null, preflight, reason: null };
  }

  return { mode: null, command: null, preflight: null, reason };
}
