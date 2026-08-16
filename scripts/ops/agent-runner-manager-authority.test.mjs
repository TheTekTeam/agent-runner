import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGER_PREFLIGHT_ALREADY_CLAIMED,
  MANAGER_PREFLIGHT_INVALID,
  MANAGER_PREFLIGHT_REQUIRED,
  MANAGER_PREFLIGHT_REVOKED,
  managerAuthorityApprovesAgent,
  managerAuthorityKeyIsCurrent,
  packetBodyDigest,
  parseManagerPreflightPacket,
  resolveCurrentManagerAuthority,
  resolveManagerPreflightExecutionMetadata,
} from './agent-runner-manager-authority.mjs';

const FINGERPRINT_A = `sha256:${'a'.repeat(64)}`;
const FINGERPRINT_B = `sha256:${'b'.repeat(64)}`;

function packet({ id = 1, revision = 'AR43.1', fingerprint = FINGERPRINT_A, producerType = 'normal_chatgpt_manager_session', extra = '' } = {}) {
  return {
    id,
    createdAt: `2026-07-23T19:${String(id).padStart(2, '0')}:00Z`,
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: ${revision}\nfingerprint: ${fingerprint}\nproducer_type: ${producerType}\napproved_agent: claude-code-cli\nexecution_phase: implementation\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\`\n${extra}`,
  };
}

function claim(authority, id = 10) {
  return {
    id,
    createdAt: `2026-07-23T20:${String(id).padStart(2, '0')}:00Z`,
    body: `## Claude runner started\n\n- Manager packet revision: ${authority.revision}\n- Manager packet fingerprint: ${authority.fingerprint}\n- Manager packet authority: ${authority.authorityKey}`,
  };
}

test('requires the canonical marker and immutable packet fields', () => {
  assert.equal(parseManagerPreflightPacket('## Manager preflight packet').reason, MANAGER_PREFLIGHT_REQUIRED);
  const malformed = packet({ fingerprint: 'sha256:short' });
  assert.equal(parseManagerPreflightPacket(malformed).reason, MANAGER_PREFLIGHT_INVALID);
  assert.equal(parseManagerPreflightPacket(packet()).valid, true);
});


test('requires bounded scope, validation and stop-condition lists', () => {
  const incomplete = packet();
  incomplete.body = incomplete.body.replace(/scope:[\s\S]*?```/, '```');
  const parsed = parseManagerPreflightPacket(incomplete);
  assert.equal(parsed.reason, MANAGER_PREFLIGHT_INVALID);
  assert.ok(parsed.errors.includes('scope'));
  assert.ok(parsed.errors.includes('required_validation'));
  assert.ok(parsed.errors.includes('stop_conditions'));
});

test('rejects worker or runner produced authority', () => {
  assert.equal(parseManagerPreflightPacket(packet({ producerType: 'claude_code_cli' })).reason, MANAGER_PREFLIGHT_INVALID);
  const generated = packet({ extra: '<!-- claude-runner-generated-preflight -->' });
  assert.equal(parseManagerPreflightPacket(generated).reason, MANAGER_PREFLIGHT_INVALID);
});

test('an unchanged revision and fingerprint remains claimed after body edits', () => {
  const first = packet();
  const authority = parseManagerPreflightPacket(first);
  const edited = packet({ id: 1, extra: '\nEdited explanatory prose only.' });
  const resolved = resolveCurrentManagerAuthority([edited, claim(authority)]);
  assert.equal(resolved.allowed, false);
  assert.equal(resolved.reason, MANAGER_PREFLIGHT_ALREADY_CLAIMED);
});

test('a newer packet supersedes an old claimed command and old packet claim', () => {
  const old = packet({ revision: 'AR43.1', fingerprint: FINGERPRINT_A });
  const oldAuthority = parseManagerPreflightPacket(old);
  const oldProceed = { id: 2, createdAt: '2026-07-23T19:02:00Z', body: '## Claude proceed command\n\nHistorical evidence.' };
  const fresh = packet({ id: 3, revision: 'AR43.2', fingerprint: FINGERPRINT_B });
  const resolved = resolveCurrentManagerAuthority([old, oldProceed, claim(oldAuthority), fresh]);
  assert.equal(resolved.allowed, true);
  assert.equal(resolved.authority.revision, 'AR43.2');
});

test('revocation blocks until a fresh immutable revision appears', () => {
  const old = packet();
  const revoked = { id: 2, createdAt: '2026-07-23T19:02:00Z', body: '## Manager preflight packet — revoked\nDo not dispatch.' };
  const blocked = resolveCurrentManagerAuthority([old, revoked]);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, MANAGER_PREFLIGHT_REVOKED);

  const fresh = packet({ id: 3, revision: 'AR43.2', fingerprint: FINGERPRINT_B });
  const resolved = resolveCurrentManagerAuthority([old, revoked, fresh]);
  assert.equal(resolved.allowed, true);
  assert.equal(resolved.authority.revision, 'AR43.2');
});


test('the exact immutable packet remains current for its pinned attempt after claim', () => {
  const current = packet();
  const authority = parseManagerPreflightPacket(current);
  const comments = [current, claim(authority)];
  assert.equal(resolveCurrentManagerAuthority(comments).reason, MANAGER_PREFLIGHT_ALREADY_CLAIMED);
  assert.equal(managerAuthorityKeyIsCurrent(comments, authority.authorityKey, authority.packetDigest), true);
  assert.equal(managerAuthorityKeyIsCurrent(comments, `manager-preflight:other:${FINGERPRINT_B}`), false);
  const edited = { ...current, body: `${current.body}
Expanded after claim.` };
  assert.equal(managerAuthorityKeyIsCurrent([edited, claim(authority)], authority.authorityKey, authority.packetDigest), false);
  assert.notEqual(packetBodyDigest(edited.body), authority.packetDigest);
});

test('revocation or a fresh packet invalidates the prior immutable authority key', () => {
  const old = packet();
  const oldAuthority = parseManagerPreflightPacket(old);
  const revoked = { id: 2, createdAt: '2026-07-23T19:02:00Z', body: '## Manager preflight packet — revoked\nDo not dispatch.' };
  assert.equal(managerAuthorityKeyIsCurrent([old, revoked], oldAuthority.authorityKey), false);

  const fresh = packet({ id: 3, revision: 'AR43.2', fingerprint: FINGERPRINT_B });
  assert.equal(managerAuthorityKeyIsCurrent([old, fresh], oldAuthority.authorityKey), false);
});

test('managerAuthorityApprovesAgent requires an exact approved_agent match to the candidate agent id', () => {
  const authority = parseManagerPreflightPacket(packet());
  assert.equal(managerAuthorityApprovesAgent(authority, 'claude-code-cli'), true);
  assert.equal(managerAuthorityApprovesAgent(authority, 'codex-cli'), false);
});

test('managerAuthorityApprovesAgent fails closed on a missing authority or a missing/blank candidate agent id', () => {
  const authority = parseManagerPreflightPacket(packet());
  assert.equal(managerAuthorityApprovesAgent(null, 'claude-code-cli'), false);
  assert.equal(managerAuthorityApprovesAgent(authority, null), false);
  assert.equal(managerAuthorityApprovesAgent(authority, ''), false);
  assert.equal(managerAuthorityApprovesAgent({}, 'claude-code-cli'), false);
});

function packetWithExecutionScalars(extraYaml = '') {
  return {
    id: 1,
    createdAt: '2026-07-23T19:01:00Z',
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: AR221.1\nfingerprint: ${FINGERPRINT_A}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nprofile: complex\nmodel: sonnet\neffort: medium\n${extraYaml}scope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\`\n`,
  };
}

test('resolveManagerPreflightExecutionMetadata extracts profile, model and effort scalars', () => {
  const metadata = resolveManagerPreflightExecutionMetadata(packetWithExecutionScalars('max_budget_usd: 0.75\n'));
  assert.equal(metadata.profile, 'complex');
  assert.equal(metadata.model, 'sonnet');
  assert.equal(metadata.effort, 'medium');
});

test('resolveManagerPreflightExecutionMetadata normalizes quoted and unquoted budgets identically', () => {
  const quoted = resolveManagerPreflightExecutionMetadata(packetWithExecutionScalars('max_budget_usd: "1.00"\n'));
  const unquoted = resolveManagerPreflightExecutionMetadata(packetWithExecutionScalars('max_budget_usd: 1.00\n'));
  assert.deepEqual(quoted.maxBudgetUsd, unquoted.maxBudgetUsd);
  assert.equal(quoted.maxBudgetUsd.present, true);
  assert.equal(quoted.maxBudgetUsd.valid, true);
  assert.equal(quoted.maxBudgetUsd.value, 1);
});

test('resolveManagerPreflightExecutionMetadata distinguishes an absent budget from an invalid one', () => {
  const absent = resolveManagerPreflightExecutionMetadata(packetWithExecutionScalars());
  assert.equal(absent.maxBudgetUsd.present, false);
  assert.equal(absent.maxBudgetUsd.valid, false);
  assert.equal(absent.maxBudgetUsd.value, null);

  const empty = resolveManagerPreflightExecutionMetadata(packetWithExecutionScalars('max_budget_usd: ""\n'));
  assert.equal(empty.maxBudgetUsd.present, true);
  assert.equal(empty.maxBudgetUsd.valid, false);
  assert.equal(empty.maxBudgetUsd.value, null);
});

test('resolveManagerPreflightExecutionMetadata fails closed on malformed, zero and negative explicit budgets', () => {
  const malformed = resolveManagerPreflightExecutionMetadata(packetWithExecutionScalars('max_budget_usd: not-a-number\n'));
  assert.equal(malformed.maxBudgetUsd.present, true);
  assert.equal(malformed.maxBudgetUsd.valid, false);
  assert.equal(malformed.maxBudgetUsd.value, null);

  const zero = resolveManagerPreflightExecutionMetadata(packetWithExecutionScalars('max_budget_usd: 0\n'));
  assert.equal(zero.maxBudgetUsd.present, true);
  assert.equal(zero.maxBudgetUsd.valid, false);
  assert.equal(zero.maxBudgetUsd.value, null);

  const negative = resolveManagerPreflightExecutionMetadata(packetWithExecutionScalars('max_budget_usd: -0.50\n'));
  assert.equal(negative.maxBudgetUsd.present, true);
  assert.equal(negative.maxBudgetUsd.valid, false);
  assert.equal(negative.maxBudgetUsd.value, null);
});

test('resolveManagerPreflightExecutionMetadata never lets an invalid explicit budget masquerade as valid or absent', () => {
  const malformed = resolveManagerPreflightExecutionMetadata(packetWithExecutionScalars('max_budget_usd: NaN\n'));
  assert.notEqual(malformed.maxBudgetUsd.valid, true);
  assert.notEqual(malformed.maxBudgetUsd.present, false);
});
