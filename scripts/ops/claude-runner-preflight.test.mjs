import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SOURCE_DOCS,
  PREFLIGHT_GENERATION_NEEDS_MANAGER,
  assessPreflightGenerationSafety,
  buildGeneratedPreflightPacket,
  computePreflightFingerprint,
  extractAcceptanceCriteria,
  extractLikelyFiles,
  extractSourceDocs,
  findGeneratedPreflightComment,
  extractGeneratedPreflightFingerprint,
  resolvePreflightAction,
} from './claude-runner-preflight.mjs';
import { hasManagerPreflight } from './claude-runner-selection.mjs';

const SAFE_BODY = `## Goal

Do the well-scoped thing described here in enough detail that a runner can safely preflight it without a human, touching \`scripts/ops/example.mjs\` and \`docs/ops/EXAMPLE.md\`.

## Acceptance criteria

- Thing one happens.
- Thing two happens.
- Tests pass.
`;

function safeIssue(overrides = {}) {
  return { number: 900, title: 'Safe bounded issue', body: SAFE_BODY, labels: [{ name: 'priority:P2' }, { name: 'agent:claude-code-cli' }], ...overrides };
}

test('extractLikelyFiles pulls backticked path-like tokens with extensions only', () => {
  const body = 'Touch `scripts/ops/example.mjs` and `docs/ops/EXAMPLE.md`, not `just-a-word` or `no/extension/here`.';
  assert.deepEqual(extractLikelyFiles(body), ['scripts/ops/example.mjs', 'docs/ops/EXAMPLE.md']);
});

test('extractSourceDocs filters likely files down to markdown docs', () => {
  const body = 'See `scripts/ops/example.mjs` and `docs/ops/EXAMPLE.md`.';
  assert.deepEqual(extractSourceDocs(body), ['docs/ops/EXAMPLE.md']);
});

test('extractAcceptanceCriteria returns bullet lines under an Acceptance criteria heading', () => {
  assert.deepEqual(extractAcceptanceCriteria(SAFE_BODY), ['Thing one happens.', 'Thing two happens.', 'Tests pass.']);
});

test('extractAcceptanceCriteria returns [] when no such heading exists', () => {
  assert.deepEqual(extractAcceptanceCriteria('## Goal\n\nJust a goal, no acceptance section.'), []);
});

test('computePreflightFingerprint is stable for identical inputs and changes when title/body/labels/PR state change', () => {
  const issue = safeIssue();
  const fp1 = computePreflightFingerprint({ issue, linkedPrs: [] });
  const fp2 = computePreflightFingerprint({ issue, linkedPrs: [] });
  assert.equal(fp1, fp2);
  assert.notEqual(fp1, computePreflightFingerprint({ issue: safeIssue({ labels: [{ name: 'priority:P0' }] }), linkedPrs: [] }));
  assert.notEqual(fp1, computePreflightFingerprint({ issue: safeIssue({ body: `${SAFE_BODY}\nmore.` }), linkedPrs: [] }));
  const fpPrChanged = computePreflightFingerprint({ issue, linkedPrs: [{ number: 5, state: 'open', merged: false }] });
  assert.notEqual(fp1, fpPrChanged);
  assert.notEqual(fpPrChanged, computePreflightFingerprint({ issue, linkedPrs: [{ number: 5, state: 'closed', merged: true }] }));
});

test('assessPreflightGenerationSafety accepts a well-scoped issue with acceptance criteria, an explicit code map and no linked open PRs', () => {
  assert.equal(assessPreflightGenerationSafety({ issue: safeIssue(), linkedOpenPrs: [] }).safe, true);
});

test('assessPreflightGenerationSafety refuses a too-short issue body', () => {
  const result = assessPreflightGenerationSafety({ issue: safeIssue({ body: 'Too short.' }), linkedOpenPrs: [] });
  assert.equal(result.safe, false);
  assert.equal(result.reason, PREFLIGHT_GENERATION_NEEDS_MANAGER);
});

test('assessPreflightGenerationSafety refuses an issue with no acceptance criteria section', () => {
  const result = assessPreflightGenerationSafety({ issue: safeIssue({ body: SAFE_BODY.replace(/## Acceptance criteria[\s\S]*/, '') + ' '.repeat(150) }), linkedOpenPrs: [] });
  assert.equal(result.safe, false);
  assert.equal(result.reason, PREFLIGHT_GENERATION_NEEDS_MANAGER);
});

test('assessPreflightGenerationSafety refuses a detailed issue with no explicit file path instead of delegating code discovery to Claude', () => {
  const body = `## Goal\n\n${'Describe the bounded product change clearly. '.repeat(8)}\n\n## Acceptance criteria\n\n- The change works.\n- Tests pass.\n`;
  const result = assessPreflightGenerationSafety({ issue: safeIssue({ body }), linkedOpenPrs: [] });
  assert.equal(result.safe, false);
  assert.equal(result.reason, PREFLIGHT_GENERATION_NEEDS_MANAGER);
  assert.match(result.detail, /bounded code map/);
});

test('assessPreflightGenerationSafety refuses an issue carrying a blocking label', () => {
  const result = assessPreflightGenerationSafety({ issue: safeIssue({ labels: [{ name: 'blocked' }] }), linkedOpenPrs: [] });
  assert.equal(result.safe, false);
  assert.equal(result.reason, PREFLIGHT_GENERATION_NEEDS_MANAGER);
});

test('assessPreflightGenerationSafety refuses an issue with a linked open PR', () => {
  const result = assessPreflightGenerationSafety({ issue: safeIssue(), linkedOpenPrs: [{ number: 1, title: 'WIP', state: 'open' }] });
  assert.equal(result.safe, false);
  assert.equal(result.reason, PREFLIGHT_GENERATION_NEEDS_MANAGER);
});

test('buildGeneratedPreflightPacket produces a packet recognised by the existing manager-preflight detector', () => {
  const packet = buildGeneratedPreflightPacket({ issue: safeIssue(), comments: [], linkedOpenPrs: [], now: new Date('2026-07-09T12:00:00.000Z') });
  assert.equal(hasManagerPreflight(packet), true);
  assert.match(packet, /_Generated locally by the Dell runner/);
  assert.match(packet, /Code map \/ likely files:\n- `scripts\/ops\/example.mjs`/);
  assert.match(packet, /Acceptance criteria distilled:\n- Thing one happens\./);
  DEFAULT_SOURCE_DOCS.forEach((doc) => assert.match(packet, new RegExp(`\`${doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``)));
});

test('buildGeneratedPreflightPacket embeds a fingerprint the module can round-trip', () => {
  const issue = safeIssue();
  const packet = buildGeneratedPreflightPacket({ issue, comments: [], linkedOpenPrs: [] });
  const fingerprint = computePreflightFingerprint({ issue, linkedPrs: [] });
  const comment = { id: 1, createdAt: '2026-07-09T12:00:00Z', body: packet };
  assert.equal(findGeneratedPreflightComment([comment]).id, 1);
  assert.equal(extractGeneratedPreflightFingerprint(comment), fingerprint);
});

test('resolvePreflightAction generates a packet for a status:ready issue with no command and no preflight', () => {
  const result = resolvePreflightAction({ issue: { ...safeIssue(), statusLabel: 'status:ready' }, comments: [], linkedOpenPrs: [] });
  assert.equal(result.action, 'generate');
  assert.equal(typeof result.packet, 'string');
  assert.equal(result.stale, false);
});

test('resolvePreflightAction blocks a ready issue whose body has no explicit file path', () => {
  const body = `## Goal\n\n${'Detailed but path-free scope. '.repeat(12)}\n\n## Acceptance criteria\n\n- Works.\n`;
  const result = resolvePreflightAction({ issue: { ...safeIssue({ body }), statusLabel: 'status:ready' }, comments: [], linkedOpenPrs: [] });
  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, PREFLIGHT_GENERATION_NEEDS_MANAGER);
});

test('resolvePreflightAction is a noop when a proceed command with embedded preflight already works', () => {
  const issue = { ...safeIssue(), statusLabel: 'status:ready' };
  const comments = [{ id: 1, createdAt: '2026-07-08T09:00:00Z', body: '## Claude proceed command\n\n## Manager preflight packet\nHuman-authored.\n\nTask: do it.' }];
  assert.equal(resolvePreflightAction({ issue, comments, linkedOpenPrs: [] }).action, 'noop');
});

test('resolvePreflightAction is a noop and never overwrites a human-authored manager preflight comment', () => {
  const issue = { ...safeIssue(), statusLabel: 'status:ready' };
  const comments = [{ id: 1, createdAt: '2026-07-08T09:00:00Z', body: '## Manager preflight packet\nHuman-authored, no proceed command.' }];
  assert.equal(resolvePreflightAction({ issue, comments, linkedOpenPrs: [] }).action, 'noop');
});

test('resolvePreflightAction reuses a current generated packet without regenerating', () => {
  const issue = { ...safeIssue(), statusLabel: 'status:ready' };
  const comments = [{ id: 1, createdAt: '2026-07-08T09:00:00Z', body: buildGeneratedPreflightPacket({ issue, comments: [], linkedOpenPrs: [] }) }];
  assert.equal(resolvePreflightAction({ issue, comments, linkedOpenPrs: [] }).action, 'noop');
});

test('resolvePreflightAction regenerates when the existing generated packet is stale', () => {
  const issue = { ...safeIssue(), statusLabel: 'status:ready' };
  const stale = buildGeneratedPreflightPacket({ issue: { ...issue, labels: [{ name: 'priority:P3' }] }, comments: [], linkedOpenPrs: [] });
  const result = resolvePreflightAction({ issue, comments: [{ id: 1, createdAt: '2026-07-08T09:00:00Z', body: stale }], linkedOpenPrs: [] });
  assert.equal(result.action, 'generate');
  assert.equal(result.stale, true);
});

test('resolvePreflightAction blocks while a dependency PR is open, then generates once it merges', () => {
  const issue = { ...safeIssue(), statusLabel: 'status:ready' };
  assert.equal(resolvePreflightAction({ issue, comments: [], linkedOpenPrs: [{ number: 5, title: 'WIP', state: 'open' }] }).action, 'blocked');
  assert.equal(resolvePreflightAction({ issue, comments: [], linkedOpenPrs: [] }).action, 'generate');
});

test('resolvePreflightAction refuses an unsafe issue instead of dispatching', () => {
  const result = resolvePreflightAction({ issue: { ...safeIssue({ body: 'Too thin to preflight safely.' }), statusLabel: 'status:ready' }, comments: [], linkedOpenPrs: [] });
  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, PREFLIGHT_GENERATION_NEEDS_MANAGER);
  assert.equal(typeof result.detail, 'string');
});

test('resolvePreflightAction is a noop for non-ready issues', () => {
  assert.equal(resolvePreflightAction({ issue: { ...safeIssue(), statusLabel: 'status:in-progress' }, comments: [], linkedOpenPrs: [] }).action, 'noop');
});

test('resolvePreflightAction is a noop when auto-preflight is disabled', () => {
  assert.equal(resolvePreflightAction({ issue: { ...safeIssue(), statusLabel: 'status:ready' }, comments: [], linkedOpenPrs: [], autoPreflightEnabled: false }).action, 'noop');
});
