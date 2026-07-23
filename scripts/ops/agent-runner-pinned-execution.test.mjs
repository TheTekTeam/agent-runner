import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PINNED_CHILD_ENTRYPOINT,
  resolvePinnedExecutionAuthority,
  runChildWithPinnedAuthority,
} from './agent-runner-pinned-atomic-cron.mjs';
import {
  createPinnedFetch,
  pinManagerAuthorityComments,
  pinnedAuthorityFromEnv,
} from './agent-runner-pinned-child.mjs';
import { packetBodyDigest } from './agent-runner-manager-authority.mjs';
import { findLatestClaudeCommand } from './claude-runner-selection.mjs';

const REVISION = 'AR43.1';
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const AUTHORITY_KEY = `manager-preflight:${REVISION}:${FINGERPRINT}`;
const OLD_CONTINUE = {
  id: 5033672061,
  createdAt: '2026-07-20T10:00:00Z',
  user: { login: 'gpcola' },
  body: '## Claude continue command\n\nContinue the old attempt.',
};
const FRESH_PREFLIGHT = {
  id: 5058216754,
  createdAt: '2026-07-23T12:10:00Z',
  user: { login: 'gpcola' },
  body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: ${REVISION}\nfingerprint: ${FINGERPRINT}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\``,
};
const BODY_DIGEST = packetBodyDigest(FRESH_PREFLIGHT.body);

function row(overrides = {}) {
  return {
    attempt_id: 'TheTekTeam/modelspend#686:attempt',
    issue_number: 686,
    claim_id: 'github-comment:database:5058216754',
    claim_identity_json: JSON.stringify({ databaseId: 5058216754 }),
    preflight_revision: 'github-comment:database:5058216754',
    preflight_identity_json: JSON.stringify({ databaseId: 5058216754 }),
    manager_preflight_revision: REVISION,
    manager_preflight_fingerprint: FINGERPRINT,
    manager_preflight_body_digest: BODY_DIGEST,
    manager_authority_key: AUTHORITY_KEY,
    ...overrides,
  };
}

function stateFor(value) {
  return { invoke(name, attemptId) { assert.equal(name, 'recoveryAttempt'); assert.equal(attemptId, value.attempt_id); return value; } };
}

function env(overrides = {}) {
  return {
    AGENT_RUNNER_PINNED_ISSUE: '686',
    AGENT_RUNNER_PINNED_SELECTION_MODE: 'preflight-direct',
    AGENT_RUNNER_PINNED_PREFLIGHT_COMMENT_REVISION: 'github-comment:database:5058216754',
    AGENT_RUNNER_PINNED_MANAGER_REVISION: REVISION,
    AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT: FINGERPRINT,
    AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST: BODY_DIGEST,
    AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY: AUTHORITY_KEY,
    ...overrides,
  };
}

test('resolves immutable preflight-direct authority from the persisted attempt', () => {
  const value = row();
  const authority = resolvePinnedExecutionAuthority({ state: stateFor(value), attemptId: value.attempt_id });
  assert.equal(authority.allowed, true);
  assert.equal(authority.selectionMode, 'preflight-direct');
  assert.equal(authority.managerPreflightRevision, REVISION);
  assert.equal(authority.managerPreflightFingerprint, FINGERPRINT);
  assert.equal(authority.managerPreflightBodyDigest, BODY_DIGEST);
  assert.equal(authority.managerAuthorityKey, AUTHORITY_KEY);
});

test('injects persisted immutable authority and replaces only the child entrypoint', async () => {
  const value = row();
  let observed = null;
  const result = await runChildWithPinnedAuthority({
    command: process.execPath,
    commandArgs: ['/runner/scripts/ops/claude-runner.mjs', '--issue', '686', '--execute'],
    options: { env: { SAFE: 'yes' } }, state: stateFor(value), attemptId: value.attempt_id,
  }, { baseRunChild: async (input) => { observed = input; return { status: 0, signal: null, stdout: '{}', stderr: '', error: null }; } });
  assert.equal(result.status, 0);
  assert.equal(observed.commandArgs[0], PINNED_CHILD_ENTRYPOINT);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_MANAGER_REVISION, REVISION);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_MANAGER_FINGERPRINT, FINGERPRINT);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_MANAGER_BODY_DIGEST, BODY_DIGEST);
  assert.equal(observed.options.env.AGENT_RUNNER_PINNED_MANAGER_AUTHORITY_KEY, AUTHORITY_KEY);
  assert.equal(observed.options.env.SAFE, 'yes');
});

test('fails closed without persisted immutable packet fields', async () => {
  const value = row({ manager_preflight_revision: null, manager_preflight_fingerprint: null, manager_preflight_body_digest: null, manager_authority_key: null });
  let invoked = false;
  const result = await runChildWithPinnedAuthority({ commandArgs: ['/runner/scripts/ops/claude-runner.mjs'], options: { env: {} }, state: stateFor(value), attemptId: value.attempt_id }, {
    baseRunChild: async () => { invoked = true; return {}; },
  });
  assert.equal(invoked, false);
  assert.equal(result.status, 4);
  assert.equal(JSON.parse(result.stdout).failureReason, 'pinned-authority-immutable-manager-packet-missing');
});

test('preflight-direct pinning removes all historical command authority', () => {
  const authority = pinnedAuthorityFromEnv(env());
  const result = pinManagerAuthorityComments([OLD_CONTINUE, FRESH_PREFLIGHT], authority);
  assert.equal(result.allowed, true);
  assert.equal(findLatestClaudeCommand(result.comments), null);
  assert.match(result.comments[0].body, /Superseded Claude command/);
});


test('refuses edited packet content without a new manager revision', () => {
  const authority = pinnedAuthorityFromEnv(env());
  const edited = { ...FRESH_PREFLIGHT, body: `${FRESH_PREFLIGHT.body}
Expanded scope after claim.` };
  const result = pinManagerAuthorityComments([edited], authority);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'pinned-child-preflight-not-current');
});

test('refuses a newer immutable manager packet', () => {
  const authority = pinnedAuthorityFromEnv(env());
  const newerFingerprint = `sha256:${'b'.repeat(64)}`;
  const newer = {
    id: 5059000000, createdAt: '2026-07-23T13:00:00Z', user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: AR43.2\nfingerprint: ${newerFingerprint}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\``,
  };
  const result = pinManagerAuthorityComments([FRESH_PREFLIGHT, newer], authority);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'pinned-child-preflight-not-current');
});

test('proceed-command pinned mode is retired', () => {
  const authority = pinnedAuthorityFromEnv(env({ AGENT_RUNNER_PINNED_SELECTION_MODE: 'proceed-command' }));
  assert.equal(authority.allowed, false);
  assert.equal(authority.reason, 'pinned-child-selection-mode-invalid');
});

test('pinned fetch rewrites only the expected issue comments response', async () => {
  const authority = pinnedAuthorityFromEnv(env());
  const originalFetch = async () => new Response(JSON.stringify([OLD_CONTINUE, FRESH_PREFLIGHT]), { status: 200, headers: { 'content-type': 'application/json' } });
  const pinnedFetch = createPinnedFetch({ authority, originalFetch });
  const response = await pinnedFetch('https://api.github.com/repos/TheTekTeam/modelspend/issues/686/comments?per_page=100');
  const comments = await response.json();
  assert.equal(findLatestClaudeCommand(comments), null);
});
