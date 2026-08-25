import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { hydratePromptWithDeterministicHandoff } from './agent-runner-agents.mjs';
import {
  buildLiveDeterministicHandoff,
  DETERMINISTIC_LIVE_HANDOFF_ENV,
  liveDeterministicHandoffPromptSection,
} from './agent-runner-deterministic-live-handoff.mjs';
import {
  buildPromptCacheMetadata,
  compilePrompt,
  joinSections,
  sha256Hex,
} from './claude-runner-prompt-compiler.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-live-cache-'));
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'agent-runner-live-cache-evidence-'));
  const mapCacheRoot = mkdtempSync(join(tmpdir(), 'agent-runner-live-cache-map-'));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Agent Runner Test');
  git(root, 'config', 'user.email', 'agent-runner-test@example.invalid');
  write(root, 'package.json', JSON.stringify({ name: 'fixture', type: 'module' }));
  write(root, 'src/index.mjs', 'export const answer = 42;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'fixture');

  const handoff = buildLiveDeterministicHandoff({
    project: { projectId: 'fixture', githubRepo: 'TheTekTeam/fixture', localRepoPath: root },
    candidateAdmission: {
      admission: { allowed: true },
      current: {
        issueNumber: 319,
        preflightFingerprint: `sha256:${'a'.repeat(64)}`,
        resolvedAgentId: 'claude-code-cli',
      },
    },
    evidenceRoot,
    mapCacheRoot,
    now: () => '2026-08-25T00:00:00.000Z',
  });
  const env = { [DETERMINISTIC_LIVE_HANDOFF_ENV]: JSON.stringify({ ...handoff, serialized: undefined }) };
  return {
    env,
    handoff,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(evidenceRoot, { recursive: true, force: true });
      rmSync(mapCacheRoot, { recursive: true, force: true });
    },
  };
}

test('effective Claude prompt and cache metadata account for the exact same deterministic suffix', () => {
  const value = fixture();
  try {
    const compiled = compilePrompt({ stableSections: ['stable'], dynamicSections: ['dynamic'] });
    const section = liveDeterministicHandoffPromptSection(value.env, { agentId: 'claude-code-cli' });
    assert.match(section, /Deterministic preflight evidence/);
    assert.match(section, new RegExp(value.handoff.headSha));

    const hydrated = hydratePromptWithDeterministicHandoff(compiled.prompt, value.env, { agentId: 'claude-code-cli' });
    assert.equal(hydrated, `stable\n\ndynamic\n\n${section}\n`);

    const metadata = buildPromptCacheMetadata({
      stableText: compiled.stableText,
      dynamicText: compiled.dynamicText,
      adapterId: 'claude-code-cli',
      model: 'sonnet',
      profile: 'narrow',
      cacheStrategy: 'provider-managed',
      env: value.env,
    });
    const effectiveDynamic = joinSections([compiled.dynamicText, section]);
    assert.equal(metadata.dynamicSuffixFingerprint, `sha256:${sha256Hex(effectiveDynamic)}`);
    assert.equal(metadata.dynamicSuffixByteEstimate, Buffer.byteLength(effectiveDynamic));
    assert.equal(metadata.liveDeterministicHandoff.included, true);
    assert.equal(metadata.liveDeterministicHandoff.byteEstimate, Buffer.byteLength(section));
  } finally { value.cleanup(); }
});

test('handoff is not injected or counted for a different adapter identity', () => {
  const value = fixture();
  try {
    const compiled = compilePrompt({ stableSections: ['stable'], dynamicSections: ['dynamic'] });
    assert.equal(liveDeterministicHandoffPromptSection(value.env, { agentId: 'codex-cli' }), '');
    assert.equal(hydratePromptWithDeterministicHandoff(compiled.prompt, value.env, { agentId: 'codex-cli' }), compiled.prompt);

    const metadata = buildPromptCacheMetadata({
      stableText: compiled.stableText,
      dynamicText: compiled.dynamicText,
      adapterId: 'codex-cli',
      model: 'some-model',
      profile: 'narrow',
      env: value.env,
    });
    assert.equal(metadata.liveDeterministicHandoff.included, false);
    assert.equal(metadata.dynamicSuffixFingerprint, `sha256:${sha256Hex(compiled.dynamicText)}`);
  } finally { value.cleanup(); }
});
