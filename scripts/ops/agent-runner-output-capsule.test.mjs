import assert from 'node:assert/strict';
import test from 'node:test';

import { EXECUTION_PHASE_IMPLEMENTATION } from './claude-runner-execution-policy.mjs';
import { buildEvidenceSchemaSection } from './claude-runner-prompt-compiler.mjs';
import {
  buildPreflightDirectPrompt,
  buildPrContinuationPromptSections,
} from './claude-runner.mjs';

const PROFILE = {
  profile: 'narrow',
  model: 'sonnet',
  effort: 'low',
  permissionMode: 'dontAsk',
};

const EXPECTED_FIELDS = [
  'branch=<branch>',
  'commit=<sha|none>',
  'pr=<draft PR URL|none>',
  'files=<comma-separated changed paths|none>',
  'validation=<compact command/result summary; no logs>',
  'blocker=<none|one concise blocker>',
  'safe_to_merge=<yes|no>',
];

function assertCompactCapsule(text) {
  assert.match(text, /return ONLY these seven newline-delimited fields and nothing else/i);
  assert.match(text, /no headings, narrative, issue restatement, implementation explanation, repeated safety prose, or raw test\/build logs/i);
  for (const field of EXPECTED_FIELDS) assert.ok(text.includes(field), `missing compact evidence field: ${field}`);
  assert.doesNotMatch(text, /Final report schema: branch, commit SHA if committed/);
}

test('canonical evidence schema requires only the compact seven-field capsule', () => {
  const schema = buildEvidenceSchemaSection();
  assertCompactCapsule(schema);
  assert.equal(schema.split('\n').length, 8);
});

test('normal preflight-direct implementation prompt consumes the compact evidence capsule once', () => {
  const prompt = buildPreflightDirectPrompt({
    issue: { number: 323, title: 'Compact worker output', body: 'Reduce final provider output.' },
    preflight: { id: 1, sourceCommentId: 1, body: '## Manager preflight packet\nBounded implementation.' },
    profile: PROFILE,
    clearContext: true,
    executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
    worktreeIdentity: { name: 'agent-runner-323-1', expectedBranch: 'chatgpt/compact-worker-output-323' },
    repositoryContext: {
      implementationRepository: 'TheTekTeam/agent-runner',
      implementationInstructionPaths: ['AGENTS.md'],
    },
  });

  assertCompactCapsule(prompt);
  assert.equal((prompt.match(/return ONLY these seven newline-delimited fields and nothing else/gi) || []).length, 1);
});

test('PR continuation prompt reuses the same compact evidence capsule once', () => {
  const { prompt } = buildPrContinuationPromptSections({
    issue: { number: 323, title: 'Compact worker output', body: 'Reduce final provider output.' },
    pullRequest: { number: 324 },
    prNumber: 324,
    branch: 'chatgpt/compact-worker-output-323',
    instructions: [{ body: 'Keep the output contract compact.' }],
    profile: PROFILE,
    clearContext: false,
    worktreeIdentity: { name: 'agent-runner-pr-324', expectedBranch: 'chatgpt/compact-worker-output-323' },
    repositoryContext: {
      implementationRepository: 'TheTekTeam/agent-runner',
      implementationInstructionPaths: ['AGENTS.md'],
    },
    authorityRevision: 'AR323-TEST',
  });

  assertCompactCapsule(prompt);
  assert.equal((prompt.match(/return ONLY these seven newline-delimited fields and nothing else/gi) || []).length, 1);
});
