import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AGENT_SETTINGS_EXAMPLE,
  CLAUDE_AGENT_ID,
  computeSettingsRevision,
  getAgentSettings,
  isAgentRoutable,
  normalizeAgentLifecycle,
  normalizeAgentPaidUsePolicy,
  normalizeAgentQualification,
  QUALIFICATION_WILDCARD,
  resolveAgentSettingsPath,
  SAFE_DEFAULT_AGENT_LIFECYCLE,
  settingsRevisionUnchanged,
  snapshotAgentSettings,
} from './agent-runner-agent-settings.mjs';

const CATALOGUE_AGENT_IDS = ['claude-code-cli', 'codex-cli', 'grok-cli', 'ollama-agent'];

function withTempSettings(payload, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-agent-settings-'));
  const settingsPath = join(dir, 'agent-settings.json');
  try {
    if (payload !== undefined) writeFileSync(settingsPath, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
    return fn(settingsPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveAgentSettingsPath defaults under the home XDG config path, outside any source checkout', () => {
  const path = resolveAgentSettingsPath({ HOME: '/home/example' });
  assert.equal(path, '/home/example/.config/agent-runner/agent-settings.json');
});

test('resolveAgentSettingsPath honours an explicit machine-local override', () => {
  const path = resolveAgentSettingsPath({ HOME: '/home/example', AGENT_RUNNER_AGENT_SETTINGS_PATH: '/etc/agent-runner/settings.json' });
  assert.equal(path, '/etc/agent-runner/settings.json');
});

test('a missing settings file yields the fully disabled safe default and is not routable', () => withTempSettings(undefined, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.equal(settings.fileFound, false);
  assert.deepEqual(settings.lifecycle, SAFE_DEFAULT_AGENT_LIFECYCLE);
  assert.equal(settings.routable, false);
  assert.equal(settings.reason, 'agent-disabled');
}));

test('an agent id absent from an existing settings file also fails closed to disabled', () => withTempSettings({ agents: {} }, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.equal(settings.fileFound, true);
  assert.equal(settings.entry, null);
  assert.deepEqual(settings.lifecycle, SAFE_DEFAULT_AGENT_LIFECYCLE);
  assert.equal(settings.routable, false);
}));

test('malformed JSON fails closed with a parse error and never throws', () => withTempSettings('{ not json', (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.equal(settings.fileFound, true);
  assert.ok(settings.parseError);
  assert.equal(settings.routable, false);
  assert.equal(settings.reason, 'agent-settings-parse-error');
}));

test('a non-object settings file body fails closed with a parse error', () => withTempSettings(['not', 'an', 'object'], (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.ok(settings.parseError);
  assert.equal(settings.routable, false);
}));

test('explicit enabled+non-disabled entry is routable', () => withTempSettings({
  agents: { 'ollama-agent': { enabled: true, disabled: false } },
}, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.deepEqual(settings.lifecycle, { enabled: true, paused: false, draining: false, disabled: false });
  assert.equal(settings.routable, true);
  assert.equal(settings.reason, 'agent-routable');
}));

test('enabled alone is not sufficient while disabled remains the fail-closed true default', () => withTempSettings({
  agents: { 'ollama-agent': { enabled: true } },
}, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.equal(settings.lifecycle.disabled, true);
  assert.equal(settings.routable, false);
  assert.equal(settings.reason, 'agent-disabled');
}));

test('paused blocks routability even when enabled and not disabled', () => withTempSettings({
  agents: { 'ollama-agent': { enabled: true, disabled: false, paused: true } },
}, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.equal(settings.routable, false);
  assert.equal(settings.reason, 'agent-paused');
}));

test('draining blocks routability even when enabled and not disabled', () => withTempSettings({
  agents: { 'ollama-agent': { enabled: true, disabled: false, draining: true } },
}, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.equal(settings.routable, false);
  assert.equal(settings.reason, 'agent-draining');
}));

test('non-boolean lifecycle fields never coerce to true', () => {
  assert.deepEqual(normalizeAgentLifecycle({ enabled: 'true', disabled: 'false', paused: 1, draining: 'yes' }), {
    enabled: false,
    paused: false,
    draining: false,
    disabled: true,
  });
});

test('adapter-specific fields on the raw entry are returned verbatim for the owning adapter to interpret', () => withTempSettings({
  agents: {
    'ollama-agent': {
      enabled: true,
      disabled: false,
      executablePath: '/usr/local/bin/opencode',
      endpoint: 'http://127.0.0.1:11434',
      installedModelAllowlist: ['qwen2.5-coder:7b'],
    },
  },
}, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.equal(settings.entry.executablePath, '/usr/local/bin/opencode');
  assert.equal(settings.entry.endpoint, 'http://127.0.0.1:11434');
  assert.deepEqual(settings.entry.installedModelAllowlist, ['qwen2.5-coder:7b']);
}));

test('isAgentRoutable mirrors getAgentSettings.routable for a bare lifecycle object', () => {
  assert.equal(isAgentRoutable({ enabled: true, paused: false, draining: false, disabled: false }), true);
  assert.equal(isAgentRoutable({ enabled: true, paused: false, draining: false, disabled: true }), false);
  assert.equal(isAgentRoutable(SAFE_DEFAULT_AGENT_LIFECYCLE), false);
});

test('the documented example settings payload itself resolves to a non-routable ollama-agent', () => withTempSettings(AGENT_SETTINGS_EXAMPLE, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'ollama-agent', settingsPath });
  assert.equal(settings.routable, false);
  assert.equal(settings.reason, 'agent-disabled');
}));

test('the documented example settings payload itself resolves to a non-routable codex-cli with no paid-use approval', () => withTempSettings(AGENT_SETTINGS_EXAMPLE, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'codex-cli', settingsPath });
  assert.equal(settings.routable, false);
  assert.equal(settings.reason, 'agent-disabled');
  assert.equal(settings.entry.paidUseApproved, false);
  assert.equal(settings.entry.maxCostUsdPerRun, 0);
  assert.equal(settings.entry.maxTokensPerRun, 0);
}));

test('the documented example settings payload itself resolves to a non-routable grok-cli with no paid-use approval, no committed executable path or session ref, and bounded timeout/tool-round defaults', () => withTempSettings(AGENT_SETTINGS_EXAMPLE, (settingsPath) => {
  const settings = getAgentSettings({ agentId: 'grok-cli', settingsPath });
  assert.equal(settings.routable, false);
  assert.equal(settings.reason, 'agent-disabled');
  assert.equal(settings.entry.paidUseApproved, false);
  assert.equal(settings.entry.maxCostUsdPerRun, 0);
  assert.equal(settings.entry.maxTokensPerRun, 0);
  assert.equal(settings.entry.executablePath, null);
  assert.equal(settings.entry.sessionSecretRef, null);
  assert.ok(Number.isInteger(settings.entry.maxToolRounds) && settings.entry.maxToolRounds > 0);
  assert.ok(Number.isInteger(settings.entry.timeout));
  assert.ok(settings.entry.timeout >= 1000 && settings.entry.timeout <= 3_600_000, 'the committed example timeout must fall within the repository-wide 1_000..3_600_000 ms bound');
}));

test('getAgentSettings requires an agentId', () => {
  assert.throws(() => getAgentSettings({ settingsPath: '/nonexistent' }), /agentId/);
});

test('the committed .agent-runner/agent-settings.example.json matches AGENT_SETTINGS_EXAMPLE exactly, so docs and code cannot drift', () => {
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const onDisk = JSON.parse(readFileSync(join(repoRoot, '.agent-runner', 'agent-settings.example.json'), 'utf8'));
  assert.deepEqual(onDisk, AGENT_SETTINGS_EXAMPLE);
});

// -- Issue #50: atomic whole-file settings snapshot + immutable revision --

test('computeSettingsRevision is a deterministic sha256 digest over the exact bytes given', () => {
  const revision = computeSettingsRevision('{"agents":{}}');
  assert.equal(revision, computeSettingsRevision('{"agents":{}}'));
  assert.notEqual(revision, computeSettingsRevision('{"agents":{}} '));
  assert.match(revision, /^sha256:[a-f0-9]{64}$/);
});

test('snapshotAgentSettings on a missing file reads zero times, reports fileFound false, and still returns a stable revision', () => withTempSettings(undefined, (settingsPath) => {
  let readCalls = 0;
  const snapshot = snapshotAgentSettings({
    settingsPath,
    fileExists: () => false,
    readFile: () => { readCalls += 1; throw new Error('must not read a file that does not exist'); },
    agentIds: CATALOGUE_AGENT_IDS,
  });
  assert.equal(readCalls, 0);
  assert.equal(snapshot.fileFound, false);
  assert.equal(snapshot.parseError, null);
  assert.match(snapshot.revision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot.revision, computeSettingsRevision(''));
}));

test('snapshotAgentSettings reads the settings file exactly once and derives the revision from those exact bytes', () => withTempSettings(AGENT_SETTINGS_EXAMPLE, (settingsPath) => {
  let readCalls = 0;
  const raw = readFileSync(settingsPath, 'utf8');
  const snapshot = snapshotAgentSettings({
    settingsPath,
    readFile: (...args) => { readCalls += 1; return readFileSync(...args); },
    agentIds: CATALOGUE_AGENT_IDS,
  });
  assert.equal(readCalls, 1);
  assert.equal(snapshot.fileFound, true);
  assert.equal(snapshot.parseError, null);
  assert.equal(snapshot.revision, computeSettingsRevision(raw));
}));

test('snapshotAgentSettings fails closed with a bounded parseError on malformed JSON, and still exposes a revision over the bytes read', () => withTempSettings('{not json', (settingsPath) => {
  const snapshot = snapshotAgentSettings({ settingsPath, agentIds: CATALOGUE_AGENT_IDS });
  assert.equal(snapshot.parseError, 'agent-settings-malformed-json');
  assert.match(snapshot.revision, /^sha256:[a-f0-9]{64}$/);
  for (const agentId of CATALOGUE_AGENT_IDS) assert.equal(snapshot.agents[agentId].routable, agentId === CLAUDE_AGENT_ID);
}));

test('snapshotAgentSettings fails closed when the document is valid JSON but not an object', () => withTempSettings('[1,2,3]', (settingsPath) => {
  const snapshot = snapshotAgentSettings({ settingsPath, agentIds: CATALOGUE_AGENT_IDS });
  assert.equal(snapshot.parseError, 'agent-settings-not-an-object');
}));

test('snapshotAgentSettings defaults claude-code-cli to enabled/routable with no settings entry at all, unlike every foundation-only adapter', () => withTempSettings(undefined, (settingsPath) => {
  const snapshot = snapshotAgentSettings({ settingsPath, agentIds: CATALOGUE_AGENT_IDS });
  assert.equal(snapshot.agents['claude-code-cli'].routable, true);
  assert.equal(snapshot.agents['claude-code-cli'].lifecycle.enabled, true);
  assert.equal(snapshot.agents['claude-code-cli'].lifecycle.disabled, false);
  for (const agentId of ['codex-cli', 'grok-cli', 'ollama-agent']) {
    assert.equal(snapshot.agents[agentId].routable, false, `${agentId} must stay non-routable with no entry`);
    assert.equal(snapshot.agents[agentId].lifecycle.disabled, true);
  }
}));

test('snapshotAgentSettings honours an explicit disabled claude-code-cli entry', () => withTempSettings({ agents: { 'claude-code-cli': { enabled: false, disabled: true } } }, (settingsPath) => {
  const snapshot = snapshotAgentSettings({ settingsPath, agentIds: CATALOGUE_AGENT_IDS });
  assert.equal(snapshot.agents['claude-code-cli'].routable, false);
  assert.equal(snapshot.agents['claude-code-cli'].lifecycle.disabled, true);
}));

test('snapshotAgentSettings honours an explicit paused claude-code-cli entry', () => withTempSettings({ agents: { 'claude-code-cli': { enabled: true, disabled: false, paused: true } } }, (settingsPath) => {
  const snapshot = snapshotAgentSettings({ settingsPath, agentIds: CATALOGUE_AGENT_IDS });
  assert.equal(snapshot.agents['claude-code-cli'].routable, false);
  assert.equal(snapshot.agents['claude-code-cli'].lifecycle.paused, true);
}));

test('snapshotAgentSettings honours an explicit draining claude-code-cli entry', () => withTempSettings({ agents: { 'claude-code-cli': { enabled: true, disabled: false, draining: true } } }, (settingsPath) => {
  const snapshot = snapshotAgentSettings({ settingsPath, agentIds: CATALOGUE_AGENT_IDS });
  assert.equal(snapshot.agents['claude-code-cli'].routable, false);
  assert.equal(snapshot.agents['claude-code-cli'].lifecycle.draining, true);
}));

test('snapshotAgentSettings never copies raw secret-shaped fields into the sanitized view', () => withTempSettings({
  agents: {
    'codex-cli': {
      enabled: true, disabled: false, executablePath: '/usr/local/bin/codex-secret-path', sessionSecretRef: 'vault://very-secret', endpoint: 'https://leak.example/token=abc',
    },
  },
}, (settingsPath) => {
  const snapshot = snapshotAgentSettings({ settingsPath, agentIds: CATALOGUE_AGENT_IDS });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /executablePath|sessionSecretRef|vault:\/\/|leak\.example|codex-secret-path/);
}));

test('normalizeAgentQualification defaults claude-code-cli to the wildcard (matches everything) when no entry or qualification block is present', () => {
  const qual = normalizeAgentQualification(CLAUDE_AGENT_ID, null);
  assert.deepEqual(qual.taskClasses, [QUALIFICATION_WILDCARD]);
  assert.deepEqual(qual.riskClasses, [QUALIFICATION_WILDCARD]);
  assert.deepEqual(qual.models, [QUALIFICATION_WILDCARD]);
  assert.equal(qual.harness, QUALIFICATION_WILDCARD);
});

test('normalizeAgentQualification defaults every other agent id to fully unqualified when no entry or qualification block is present', () => {
  for (const agentId of ['codex-cli', 'grok-cli', 'ollama-agent']) {
    const qual = normalizeAgentQualification(agentId, null);
    assert.deepEqual(qual.taskClasses, []);
    assert.deepEqual(qual.riskClasses, []);
    assert.deepEqual(qual.models, []);
    assert.equal(qual.harness, null);
  }
});

test('normalizeAgentQualification reads an explicit bounded qualification block', () => {
  const qual = normalizeAgentQualification('ollama-agent', { qualification: { taskClasses: ['docs'], riskClasses: ['low'], models: ['llama3'], harness: 'ollama-cli' } });
  assert.deepEqual(qual.taskClasses, ['docs']);
  assert.deepEqual(qual.riskClasses, ['low']);
  assert.deepEqual(qual.models, ['llama3']);
  assert.equal(qual.harness, 'ollama-cli');
});

test('normalizeAgentQualification falls back per-field to the agent default when a qualification sub-field is malformed', () => {
  const qual = normalizeAgentQualification(CLAUDE_AGENT_ID, { qualification: { taskClasses: 'not-an-array' } });
  assert.deepEqual(qual.taskClasses, [QUALIFICATION_WILDCARD]);
});

test('normalizeAgentPaidUsePolicy requires a strictly positive cost or token cap to report hasPositiveCap', () => {
  assert.equal(normalizeAgentPaidUsePolicy({ maxCostUsdPerRun: 0, maxTokensPerRun: 0 }).hasPositiveCap, false);
  assert.equal(normalizeAgentPaidUsePolicy({ maxCostUsdPerRun: 5, maxTokensPerRun: 0 }).hasPositiveCap, true);
  assert.equal(normalizeAgentPaidUsePolicy({ maxCostUsdPerRun: 0, maxTokensPerRun: 1000 }).hasPositiveCap, true);
});

test('normalizeAgentPaidUsePolicy only reports approval booleans on an exact `=== true`', () => {
  assert.equal(normalizeAgentPaidUsePolicy({ paidUseApproved: 'yes', automaticRoutingApproved: 1 }).paidUseApproved, false);
  assert.equal(normalizeAgentPaidUsePolicy({ paidUseApproved: true, automaticRoutingApproved: true }).automaticRoutingApproved, true);
});

test('settingsRevisionUnchanged requires an exact revision match with no parse error on either snapshot', () => {
  const a = { revision: 'sha256:aaa', parseError: null };
  const b = { revision: 'sha256:aaa', parseError: null };
  const c = { revision: 'sha256:bbb', parseError: null };
  assert.equal(settingsRevisionUnchanged(a, b), true);
  assert.equal(settingsRevisionUnchanged(a, c), false);
  assert.equal(settingsRevisionUnchanged(a, { revision: 'sha256:aaa', parseError: 'agent-settings-malformed-json' }), false);
  assert.equal(settingsRevisionUnchanged(null, b), false);
  assert.equal(settingsRevisionUnchanged(a, null), false);
});
