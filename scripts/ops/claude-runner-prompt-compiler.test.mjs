import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEvidenceSchemaSection,
  buildExecutionPhaseInvariantsSection,
  buildPromptCacheMetadata,
  buildRepositoryInstructionContractSection,
  buildSafetyAuthorityInvariantsSection,
  CACHE_STRATEGIES,
  compilePrompt,
  joinSections,
  PROMPT_SCHEMA_VERSION,
  sha256Hex,
} from './claude-runner-prompt-compiler.mjs';
import {
  buildPreflightDirectPrompt,
  claudePromptCacheMetadata,
  EXECUTION_PHASE_IMPLEMENTATION,
  EXECUTION_PHASE_PLAN,
} from './claude-runner.mjs';

test('joinSections drops empty/falsy sections and separates the rest with a blank line', () => {
  assert.equal(joinSections(['a', '', null, undefined, 'b']), 'a\n\nb');
  assert.equal(joinSections([]), '');
});

test('compilePrompt places the clear prefix first, then stable sections, then dynamic sections', () => {
  const { prompt, stableText, dynamicText } = compilePrompt({
    clearPrefix: 'Start a fresh task context. Do not carry assumptions or files from any previous Claude task.\n\n',
    stableSections: ['STABLE-ONE', 'STABLE-TWO'],
    dynamicSections: ['DYNAMIC-ONE'],
  });
  assert.equal(stableText, 'STABLE-ONE\n\nSTABLE-TWO');
  assert.equal(dynamicText, 'DYNAMIC-ONE');
  const stableIndex = prompt.indexOf('STABLE-ONE');
  const dynamicIndex = prompt.indexOf('DYNAMIC-ONE');
  assert.ok(stableIndex < dynamicIndex, 'stable content must precede dynamic content');
  assert.match(prompt, /^Start a fresh task context\./);
});

test('the safety/authority invariants section never mentions issue-specific or profile-value content', () => {
  const section = buildSafetyAuthorityInvariantsSection();
  assert.doesNotMatch(section, /Issue: #/);
  assert.match(section, /Do not invoke Agent\/Task subagents/);
  assert.match(section, /Do not hardcode secrets/);
});

test('the model/effort statement appears exactly once across a compiled preflight-direct prompt (no duplicated boilerplate)', () => {
  const issue = { number: 641, title: 'Agent Runner v2', body: 'Implement preflight-direct dispatch.' };
  const preflight = { id: 12, sourceCommentId: 12, body: '## Manager preflight packet\nFiles checked by ChatGPT.' };
  const profile = { profile: 'complex', model: 'sonnet', effort: 'high' };
  const prompt = buildPreflightDirectPrompt({ issue, preflight, profile, clearContext: false });
  const occurrences = prompt.match(/Model\/effort profile selected by runner:/g) || [];
  assert.equal(occurrences.length, 1);
  const subagentOccurrences = prompt.match(/Do not invoke Agent\/Task subagents/g) || [];
  assert.equal(subagentOccurrences.length, 1);
});

test('execution-phase invariants section text does not embed a dynamic worktree/branch name -- worktree identity is dynamic, not part of the stable phase boilerplate', () => {
  const implementationSection = buildExecutionPhaseInvariantsSection(EXECUTION_PHASE_IMPLEMENTATION);
  assert.doesNotMatch(implementationSection, /worktree-agent-runner/);
  assert.match(implementationSection, /Execution phase: implementation/);
  const planSection = buildExecutionPhaseInvariantsSection(EXECUTION_PHASE_PLAN);
  assert.match(planSection, /Execution phase: plan/);
});

test('repository instruction contract section renders one Follow line per configured path and nothing when no paths are configured', () => {
  const section = buildRepositoryInstructionContractSection(['CLAUDE.md', 'docs/claude/README.md']);
  assert.match(section, /- Follow CLAUDE\.md\./);
  assert.match(section, /- Follow docs\/claude\/README\.md\./);
  assert.equal(buildRepositoryInstructionContractSection([]), '');
});

test('evidence schema section requires the compact seven-field final capsule', () => {
  const section = buildEvidenceSchemaSection();
  assert.match(section, /return ONLY these seven newline-delimited fields and nothing else/i);
  assert.match(section, /branch=<branch>/);
  assert.match(section, /commit=<sha\|none>/);
  assert.match(section, /pr=<draft PR URL\|none>/);
  assert.match(section, /files=<comma-separated changed paths\|none>/);
  assert.match(section, /validation=<compact command\/result summary; no logs>/);
  assert.match(section, /blocker=<none\|one concise blocker>/);
  assert.match(section, /safe_to_merge=<yes\|no>/);
  assert.match(section, /no headings, narrative, issue restatement, implementation explanation, repeated safety prose, or raw test\/build logs/i);
});

test('buildPromptCacheMetadata never contains prompt text, only bounded content-addressed fingerprints and estimates', () => {
  const metadata = buildPromptCacheMetadata({
    stableText: 'stable section content that must never leak',
    dynamicText: 'dynamic section content that must never leak',
    adapterId: 'claude-code-cli',
    model: 'sonnet',
    profile: 'complex',
    cacheStrategy: 'provider-managed',
  });
  assert.equal(metadata.schemaVersion, PROMPT_SCHEMA_VERSION);
  assert.match(metadata.stablePrefixFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(metadata.dynamicSuffixFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof metadata.stablePrefixByteEstimate, 'number');
  assert.equal(typeof metadata.dynamicSuffixTokenEstimate, 'number');
  assert.equal(metadata.adapterId, 'claude-code-cli');
  assert.equal(metadata.model, 'sonnet');
  assert.equal(metadata.profile, 'complex');
  assert.equal(metadata.cacheStrategy, 'provider-managed');
  const serialized = JSON.stringify(metadata);
  assert.doesNotMatch(serialized, /must never leak/);
});

test('buildPromptCacheMetadata rejects an unrecognised cache strategy rather than guessing one', () => {
  assert.throws(() => buildPromptCacheMetadata({ stableText: 'x', dynamicText: 'y', cacheStrategy: 'made-up-strategy' }));
  for (const strategy of CACHE_STRATEGIES) {
    assert.doesNotThrow(() => buildPromptCacheMetadata({ stableText: 'x', dynamicText: 'y', cacheStrategy: strategy }));
  }
});

test('sha256Hex is deterministic and one-way: identical text always yields the identical digest, and the digest alone cannot reveal the text', () => {
  assert.equal(sha256Hex('same content'), sha256Hex('same content'));
  assert.notEqual(sha256Hex('same content'), sha256Hex('different content'));
  assert.equal(sha256Hex('same content').length, 64);
});

// Deterministic-fingerprint fixtures: the same policy (profile, repository
// context, execution phase) compiled for two different issue numbers must
// produce the identical stable-prefix fingerprint -- the whole point of a
// stable prefix is that it does not vary with the dynamic issue identity.
const BASE_POLICY = {
  profile: { profile: 'complex', model: 'sonnet', effort: 'medium' },
  executionPhase: EXECUTION_PHASE_IMPLEMENTATION,
  clearContext: true,
  worktreeIdentity: { name: 'agent-runner-1-1', expectedBranch: 'worktree-agent-runner-1-1' },
};

test('the stable-prefix fingerprint is identical across different issue numbers under the same policy', () => {
  const metadataA = claudePromptCacheMetadata({
    ...BASE_POLICY,
    issue: { number: 111, title: 'First issue', body: 'Body A' },
    preflight: { id: 1, body: 'Packet A' },
    selectionMode: 'preflight-direct',
  });
  const metadataB = claudePromptCacheMetadata({
    ...BASE_POLICY,
    issue: { number: 999, title: 'A very different title entirely', body: 'Body B, totally different' },
    preflight: { id: 2, body: 'Packet B, also totally different' },
    selectionMode: 'preflight-direct',
  });
  assert.equal(metadataA.stablePrefixFingerprint, metadataB.stablePrefixFingerprint);
  assert.notEqual(metadataA.dynamicSuffixFingerprint, metadataB.dynamicSuffixFingerprint);
});

test('the stable-prefix fingerprint changes when the execution phase (a genuine policy change) changes', () => {
  const implementationMetadata = claudePromptCacheMetadata({
    ...BASE_POLICY,
    issue: { number: 111, title: 'First issue', body: 'Body A' },
    preflight: { id: 1, body: 'Packet A' },
    selectionMode: 'preflight-direct',
  });
  const planMetadata = claudePromptCacheMetadata({
    ...BASE_POLICY,
    executionPhase: EXECUTION_PHASE_PLAN,
    issue: { number: 111, title: 'First issue', body: 'Body A' },
    preflight: { id: 1, body: 'Packet A' },
    selectionMode: 'preflight-direct',
  });
  assert.notEqual(implementationMetadata.stablePrefixFingerprint, planMetadata.stablePrefixFingerprint);
});

test('the stable-prefix fingerprint changes when the applicable repository instruction paths change', () => {
  const defaultInstructions = claudePromptCacheMetadata({
    ...BASE_POLICY,
    issue: { number: 111, title: 'First issue', body: 'Body A' },
    preflight: { id: 1, body: 'Packet A' },
    selectionMode: 'preflight-direct',
  });
  const runnerInstructions = claudePromptCacheMetadata({
    ...BASE_POLICY,
    issue: { number: 111, title: 'First issue', body: 'Body A' },
    preflight: { id: 1, body: 'Packet A' },
    selectionMode: 'preflight-direct',
    repositoryContext: { implementationRepository: 'TheTekTeam/agent-runner', implementationInstructionPaths: ['AGENTS.md'] },
  });
  assert.notEqual(defaultInstructions.stablePrefixFingerprint, runnerInstructions.stablePrefixFingerprint);
});

// Semantic-equivalence fixture: the compiled prompt must still carry every
// required authority/invariant field regardless of how the compiler orders
// or dedupes the underlying text.
test('semantic equivalence: the compiled preflight-direct prompt still carries every required authority invariant', () => {
  const issue = { number: 686, title: 'Standalone runner acceptance', body: 'Acceptance body.' };
  const preflight = { id: 5029607103, sourceCommentId: 5029607103, body: '## Manager preflight packet\nBounded scope.' };
  const profile = { profile: 'complex', model: 'sonnet', effort: 'medium' };
  const worktreeIdentity = { name: 'agent-runner-686-5029607103', expectedBranch: 'worktree-agent-runner-686-5029607103' };
  const prompt = buildPreflightDirectPrompt({
    issue, preflight, profile, clearContext: true,
    executionPhase: EXECUTION_PHASE_IMPLEMENTATION, worktreeIdentity,
    repositoryContext: { implementationRepository: 'TheTekTeam/agent-runner', implementationInstructionPaths: ['AGENTS.md'] },
  });

  const requiredInvariants = [
    /Selection mode: preflight-direct/,
    /You are Claude Code CLI working on TheTekTeam\/agent-runner\./,
    /Follow AGENTS\.md\./,
    /Execution phase: implementation/,
    /worktree-agent-runner-686-5029607103/,
    /Never merge, approve, close the issue, force-push, or change other branches/,
    /Do not invoke Agent\/Task subagents/,
    /Do not hardcode secrets/,
    /Manager preflight packet\nBounded scope\./,
    /safe_to_merge=<yes\|no>/,
  ];
  for (const pattern of requiredInvariants) {
    assert.match(prompt, pattern);
  }
});
