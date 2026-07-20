#!/usr/bin/env node

// Local deterministic manager preflight packet generation (Agent Runner v2.2).
//
// This module lets the Dell runner generate its own `## Manager preflight
// packet` comment for a status:ready issue that has neither a proceed
// command nor a manager preflight, instead of skipping every ready issue
// with `missing manager preflight packet` forever. It never calls an
// external AI or LLM API: packets are built deterministically from
// GitHub-visible issue/comment/PR data plus a small set of default repo
// docs. If the issue is too thin, ambiguous, lacks an explicit code map, or
// has an active linked PR, generation is refused with a structured reason
// instead of pushing broad repository discovery back onto Claude.

import { createHash } from 'node:crypto';

import { commentId, commentTime, latestManagerPreflightComment, runnableCommandForIssue, STATUS_READY } from './claude-runner-selection.mjs';

export const GENERATED_PREFLIGHT_MARKER = 'claude-runner-generated-preflight';
export const PREFLIGHT_GENERATION_NEEDS_MANAGER = 'preflight-generation-needs-manager';
export const MIN_BODY_LENGTH_FOR_AUTO_PREFLIGHT = 200;

export const DEFAULT_SOURCE_DOCS = [
  'AGENTS.md',
  'docs/ai/AGENT-REPO-RULES.md',
  'docs/ops/AGENT-RUNNER-KIT.md',
  '.agent-runner/README.md',
];

export const DEFAULT_VALIDATION_PLAN = [
  'node --test scripts/ops/claude-runner*.test.mjs',
  'pnpm validate:quick',
];

const BLOCKING_LABEL_PATTERN = /^(blocked|needs-discussion|needs-manager|status:blocked)$/i;

function labelNames(issue) {
  return (issue?.labels || []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
}

/**
 * Backticked, slash-containing, extension-bearing tokens in the issue body —
 * a conservative proxy for file paths the issue author already named.
 */
export function extractLikelyFiles(body = '') {
  const matches = [...String(body || '').matchAll(/`([\w.@-]+(?:\/[\w.@-]+)+)`/g)];
  const paths = matches.map((match) => match[1]).filter((path) => /\.[a-zA-Z0-9]+$/.test(path));
  return [...new Set(paths)];
}

export function extractSourceDocs(body = '') {
  return extractLikelyFiles(body).filter((path) => path.toLowerCase().endsWith('.md'));
}

/**
 * Bullet lines under an "Acceptance criteria" heading. Returns [] when no
 * such section exists so callers can fail closed instead of fabricating
 * criteria.
 */
export function extractAcceptanceCriteria(body = '') {
  const text = String(body || '');
  const headingMatch = text.match(/^#{1,4}\s*acceptance criteria\s*$/im);
  if (!headingMatch) return [];

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = text.slice(sectionStart);
  const nextHeadingMatch = rest.match(/^#{1,4}\s+\S/m);
  const section = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;

  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

/**
 * Deterministic fingerprint over the inputs that should invalidate a
 * generated packet: title, body, labels, and the open/merged state of any
 * linked PRs. Unrelated churn (issue updatedAt, unrelated comments) is
 * intentionally excluded so the fingerprint stays stable run-to-run.
 */
export function computePreflightFingerprint({ issue, linkedPrs = [] }) {
  const labels = labelNames(issue).slice().sort();
  const prState = linkedPrs
    .map((pr) => `${pr.number}:${pr.state || 'open'}:${pr.merged ? 'merged' : 'unmerged'}`)
    .sort();
  const canonical = JSON.stringify({ title: issue.title || '', body: issue.body || '', labels, linkedPrs: prState });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function findGeneratedPreflightComment(comments = []) {
  return [...comments]
    .filter((comment) => String(comment?.body || '').includes(GENERATED_PREFLIGHT_MARKER))
    .sort((left, right) => String(commentTime(right)).localeCompare(String(commentTime(left))))[0] || null;
}

export function extractGeneratedPreflightFingerprint(comment) {
  if (!comment) return null;
  const match = String(comment.body || '').match(/fingerprint="([a-f0-9]+)"/);
  return match ? match[1] : null;
}

/**
 * Conservative safety gate. Refuses generation (rather than guessing) when
 * the issue is too thin, carries a blocking label, has no explicit
 * acceptance criteria section, lacks at least one explicit likely file path,
 * or has an open PR plausibly already in flight for it.
 */
export function assessPreflightGenerationSafety({ issue, linkedOpenPrs = [] }) {
  const body = String(issue.body || '').trim();
  const labels = labelNames(issue);

  const blockingLabel = labels.find((label) => BLOCKING_LABEL_PATTERN.test(label));
  if (blockingLabel) {
    return { safe: false, reason: PREFLIGHT_GENERATION_NEEDS_MANAGER, detail: `issue carries a blocking label: ${blockingLabel}` };
  }
  if (body.length < MIN_BODY_LENGTH_FOR_AUTO_PREFLIGHT) {
    return { safe: false, reason: PREFLIGHT_GENERATION_NEEDS_MANAGER, detail: 'issue body is too short for confident automatic preflight generation' };
  }
  if (extractAcceptanceCriteria(body).length === 0) {
    return { safe: false, reason: PREFLIGHT_GENERATION_NEEDS_MANAGER, detail: 'no explicit acceptance criteria section found in issue body' };
  }
  if (extractLikelyFiles(body).length === 0) {
    return {
      safe: false,
      reason: PREFLIGHT_GENERATION_NEEDS_MANAGER,
      detail: 'no explicit source, test, config, migration or documentation file path found in issue body; manager research must provide a bounded code map',
    };
  }
  if (linkedOpenPrs.length > 0) {
    return { safe: false, reason: PREFLIGHT_GENERATION_NEEDS_MANAGER, detail: `issue has ${linkedOpenPrs.length} linked open PR(s); a human/manager should confirm scope before auto-preflight` };
  }
  return { safe: true, reason: null, detail: null };
}

export function buildGeneratedPreflightPacket({ issue, comments = [], linkedOpenPrs = [], now = new Date() }) {
  const fingerprint = computePreflightFingerprint({ issue, linkedPrs: linkedOpenPrs });
  const labels = labelNames(issue);
  const likelyFiles = extractLikelyFiles(issue.body);
  const sourceDocs = [...new Set([...DEFAULT_SOURCE_DOCS, ...extractSourceDocs(issue.body)])];
  const acceptanceCriteria = extractAcceptanceCriteria(issue.body);

  const codeMapLines = likelyFiles.map((file) => `- \`${file}\``).join('\n');

  const acceptanceLines = acceptanceCriteria.length
    ? acceptanceCriteria.map((line) => `- ${line}`).join('\n')
    : '- No explicit acceptance criteria section was found; treat the issue title/body as the scope bound and stop if scope expands beyond it.';

  const prLines = linkedOpenPrs.length
    ? linkedOpenPrs.map((pr) => `- #${pr.number} (${pr.state || 'open'}) — ${pr.title || ''}`).join('\n')
    : '- No open PRs linked to this issue were found.';

  const timestamp = now.toISOString();

  return [
    '## Manager preflight packet',
    '',
    `<!-- ${GENERATED_PREFLIGHT_MARKER} fingerprint="${fingerprint}" issue="${issue.number}" -->`,
    '_Generated locally by the Dell runner (deterministic, no external AI calls)._',
    '',
    `Checked ${timestamp}. Selected issue: #${issue.number} — ${issue.title || ''}. Priority rationale: this issue reached the front of the runner queue by status/priority/recency ordering; labels: ${labels.join(', ') || '(none)'}.`,
    '',
    'Dependency/PR/comment state checked:',
    `- ${comments.length} existing issue comment(s) reviewed.`,
    prLines,
    '',
    'Source-of-truth docs to read:',
    sourceDocs.map((doc) => `- \`${doc}\``).join('\n'),
    '',
    'Code map / likely files:',
    codeMapLines,
    '',
    'Expected read/edit/create/delete actions:',
    '- Read the source docs and likely files above before editing.',
    '- Edit/create only what is needed to satisfy the acceptance criteria below.',
    '- Do not delete files unless the issue explicitly requires it.',
    '',
    'Recent-work impact: not automatically analyzed by this generator; review recent merged PRs touching the same area before starting broad changes.',
    '',
    'Third-party research: none assumed. If the issue turns out to require external research, stop and flag it instead of guessing.',
    '',
    'Acceptance criteria distilled:',
    acceptanceLines,
    '',
    'Risk controls and stop conditions:',
    '- Stop if scope expands beyond the issue body and the acceptance criteria above.',
    '- Stop if implementation requires external AI calls, systemd changes, GitHub auth changes, or quota/preflight safety weakening.',
    '- Stop if a human/manager decision is needed that this generated packet cannot resolve.',
    '',
    'Validation plan:',
    '```bash',
    ...DEFAULT_VALIDATION_PLAN,
    '```',
    '',
    `Generated: ${timestamp}`,
    `Fingerprint: ${fingerprint}`,
    '',
  ].join('\n');
}

/**
 * Decide what (if anything) the runner should do about preflight for one
 * status:ready candidate issue:
 *
 * - 'noop'     proceed-command mode already works, a human packet already
 *              exists, or a previously generated packet is still current —
 *              nothing to change.
 * - 'generate' safe to (re)generate; caller should post `packet` and
 *              re-evaluate selection with the appended comment.
 * - 'blocked'  not safe to auto-preflight; caller should skip this issue
 *              with the structured `reason`/`detail` and keep scanning.
 */
export function resolvePreflightAction({ issue, comments = [], linkedOpenPrs = [], now = new Date(), autoPreflightEnabled = true, requireManagerPreflight = true }) {
  if (!autoPreflightEnabled || issue.statusLabel !== STATUS_READY) {
    return { action: 'noop', reason: null };
  }

  const { command, reason: commandReason } = runnableCommandForIssue(issue, comments, { requireManagerPreflight });
  if (command || commandReason !== 'missing proceed command') {
    // Either proceed-command mode already works, or the failure isn't "no
    // command at all" (already claimed, or a command exists but its own
    // embedded preflight is missing) — none of those are ours to fix here.
    return { action: 'noop', reason: null };
  }

  const existing = latestManagerPreflightComment(comments);
  const generatedComment = existing ? findGeneratedPreflightComment(comments) : null;
  if (existing && commentId(existing) !== commentId(generatedComment)) {
    return { action: 'noop', reason: null }; // human-authored packet — never touch it
  }

  const freshFingerprint = computePreflightFingerprint({ issue, linkedPrs: linkedOpenPrs });
  if (generatedComment && extractGeneratedPreflightFingerprint(generatedComment) === freshFingerprint) {
    return { action: 'noop', reason: null }; // current generated packet — reuse as-is
  }

  const safety = assessPreflightGenerationSafety({ issue, linkedOpenPrs });
  if (!safety.safe) {
    return { action: 'blocked', reason: safety.reason, detail: safety.detail };
  }

  const packet = buildGeneratedPreflightPacket({ issue, comments, linkedOpenPrs, now });
  return { action: 'generate', packet, fingerprint: freshFingerprint, stale: Boolean(generatedComment), reason: null };
}
