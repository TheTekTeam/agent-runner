import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AGENT_SETTINGS_EXAMPLE,
  getAgentSettings,
  isAgentRoutable,
  normalizeAgentLifecycle,
  resolveAgentSettingsPath,
  SAFE_DEFAULT_AGENT_LIFECYCLE,
} from './agent-runner-agent-settings.mjs';

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
