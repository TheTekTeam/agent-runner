import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentCommandArgs,
  resolveAgentById,
} from './agent-runner-agents.mjs';
import {
  DETERMINISTIC_LIVE_HANDOFF_ENV,
  renderLiveDeterministicHandoffForProvider,
} from './agent-runner-deterministic-live-handoff.mjs';

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function handoff() {
  const payload = {
    schemaVersion: 1,
    available: true,
    optional: true,
    issueNumber: 320,
    authorityFingerprint: `sha256:${'a'.repeat(64)}`,
    agentId: 'claude-code-cli',
    sourceFingerprint: `sha256:${'b'.repeat(64)}`,
    headSha: 'c'.repeat(40),
    evidenceReused: 3,
    results: [
      {
        capability: 'repository-identity',
        status: 'success',
        reused: true,
        result: { repository: 'TheTekTeam/agent-runner', detail: 'identity-detail-that-was-already-in-the-bound-session' },
        resultDigest: `sha256:${'1'.repeat(64)}`,
      },
      {
        capability: 'changed-files',
        status: 'success',
        reused: false,
        result: { files: ['scripts/ops/agent-runner-agents.mjs'] },
        resultDigest: `sha256:${'2'.repeat(64)}`,
      },
      {
        capability: 'repository-map',
        status: 'success',
        reused: true,
        result: { map: `prior-map-${'x'.repeat(1200)}` },
        resultDigest: `sha256:${'3'.repeat(64)}`,
      },
      {
        capability: 'toolchain-facts',
        status: 'success',
        reused: true,
        result: { tools: `prior-toolchain-${'y'.repeat(1200)}` },
        resultDigest: `sha256:${'4'.repeat(64)}`,
      },
    ],
  };
  return { ...payload, handoffDigest: digest(payload) };
}

const PROFILE = {
  model: 'sonnet',
  effort: 'medium',
  permissionMode: 'dontAsk',
};

test('fresh provider work retains the full bounded deterministic handoff', () => {
  const value = handoff();
  const full = renderLiveDeterministicHandoffForProvider(value, { agentId: 'claude-code-cli' });
  assert.match(full, /exactIdentityEvidence/);
  assert.match(full, /prior-map-/);
  assert.match(full, /prior-toolchain-/);
  assert.doesNotMatch(full, /continuationMode/);
});

test('exact resumed session receives only current identity, changed-file facts and evidence digests', () => {
  const value = handoff();
  const full = renderLiveDeterministicHandoffForProvider(value, { agentId: 'claude-code-cli' });
  const delta = renderLiveDeterministicHandoffForProvider(value, { agentId: 'claude-code-cli', deltaOnly: true });
  assert.match(delta, /"continuationMode":"delta-only"/);
  assert.match(delta, /agent-runner-agents\.mjs/);
  assert.match(delta, /evidenceDigests/);
  assert.doesNotMatch(delta, /prior-map-/);
  assert.doesNotMatch(delta, /prior-toolchain-/);
  assert.equal(Buffer.byteLength(delta, 'utf8') < Buffer.byteLength(full, 'utf8'), true);
});

test('command builder uses delta-only evidence only when an exact resume session is supplied', () => {
  const value = handoff();
  const env = { [DETERMINISTIC_LIVE_HANDOFF_ENV]: JSON.stringify(value) };
  const agent = resolveAgentById('claude-code-cli');

  const fresh = buildAgentCommandArgs({ agent, prompt: 'base prompt', profile: PROFILE, env });
  const resumed = buildAgentCommandArgs({ agent, prompt: 'base prompt', profile: PROFILE, resumeSession: 'session-123', env });
  const freshPrompt = fresh.at(-1);
  const resumedPrompt = resumed.at(-1);

  assert.match(freshPrompt, /exactIdentityEvidence/);
  assert.match(freshPrompt, /prior-map-/);
  assert.match(resumedPrompt, /"continuationMode":"delta-only"/);
  assert.doesNotMatch(resumedPrompt, /prior-map-/);
  assert.equal(Buffer.byteLength(resumedPrompt, 'utf8') < Buffer.byteLength(freshPrompt, 'utf8'), true);
  assert.deepEqual(resumed.slice(0, 2), ['--resume', 'session-123']);
  assert.equal(resumed.includes('--max-turns'), false);
});

test('invalid or cross-agent deterministic evidence is omitted rather than expanded', () => {
  const value = handoff();
  const env = { [DETERMINISTIC_LIVE_HANDOFF_ENV]: JSON.stringify(value) };
  const rendered = renderLiveDeterministicHandoffForProvider(value, { agentId: 'codex-cli', deltaOnly: true });
  assert.equal(rendered, null);
  const bad = { ...value, handoffDigest: `sha256:${'0'.repeat(64)}` };
  assert.equal(renderLiveDeterministicHandoffForProvider(bad, { agentId: 'claude-code-cli', deltaOnly: true }), null);
  assert.equal(typeof env[DETERMINISTIC_LIVE_HANDOFF_ENV], 'string');
});
