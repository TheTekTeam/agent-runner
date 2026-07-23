import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getAgentSettings } from './agent-runner-agent-settings.mjs';
import {
  CONTROL_SETTINGS_SCHEMA_VERSION,
  ControlSettingsLockedError,
  ControlSettingsRollbackUnavailableError,
  ControlSettingsStaleRevisionError,
  listControlSettingsHistory,
  loadControlSettingsDocument,
  replaceControlSettingsDocument,
  rollbackControlSettings,
} from './agent-runner-control-settings-store.mjs';

function withTempSettingsPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-control-settings-'));
  try {
    return fn(join(dir, 'agent-settings.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadControlSettingsDocument returns an empty revision-0 document when no file exists', () => withTempSettingsPath((path) => {
  const loaded = loadControlSettingsDocument(path);
  assert.equal(loaded.found, false);
  assert.equal(loaded.revision, 0);
  assert.deepEqual(loaded.doc.agents, {});
}));

test('loadControlSettingsDocument adopts a pre-existing #40 agents-only file at revision 0', () => withTempSettingsPath((path) => {
  writeFileSync(path, JSON.stringify({ agents: { 'ollama-agent': { enabled: false, disabled: true } } }));
  const loaded = loadControlSettingsDocument(path);
  assert.equal(loaded.found, true);
  assert.equal(loaded.revision, 0);
  assert.deepEqual(loaded.doc.agents['ollama-agent'], { enabled: false, disabled: true });
}));

test('replaceControlSettingsDocument writes revision 1 atomically at mode 0600', () => withTempSettingsPath((path) => {
  const result = replaceControlSettingsDocument({
    path,
    mutate: (agents) => ({ ...agents, 'claude-code-cli': { enabled: true, paused: false, draining: false, disabled: false } }),
  });
  assert.equal(result.revision, 1);
  assert.equal(result.previousRevision, 0);
  const stats = statSync(path);
  assert.equal(stats.mode & 0o777, 0o600);
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(onDisk.schemaVersion, CONTROL_SETTINGS_SCHEMA_VERSION);
  assert.equal(onDisk.revision, 1);
}));

test('a write committed here is immediately visible to getAgentSettings — no restart, no cache', () => withTempSettingsPath((path) => {
  replaceControlSettingsDocument({
    path,
    mutate: (agents) => ({ ...agents, 'claude-code-cli': { enabled: true, paused: false, draining: false, disabled: false } }),
  });
  const settings = getAgentSettings({ agentId: 'claude-code-cli', settingsPath: path });
  assert.equal(settings.routable, true);
}));

test('stale write is rejected and the last known good revision is preserved', () => withTempSettingsPath((path) => {
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 1 } }) }); // revision 1
  assert.throws(
    () => replaceControlSettingsDocument({ path, expectedRevision: 0, mutate: (agents) => ({ ...agents, a: { v: 2 } }) }),
    ControlSettingsStaleRevisionError,
  );
  const { doc } = loadControlSettingsDocument(path);
  assert.equal(doc.revision, 1);
  assert.deepEqual(doc.agents.a, { v: 1 });
}));

test('a matching expectedRevision succeeds and advances the revision', () => withTempSettingsPath((path) => {
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 1 } }) });
  const result = replaceControlSettingsDocument({ path, expectedRevision: 1, mutate: (agents) => ({ ...agents, a: { v: 2 } }) });
  assert.equal(result.revision, 2);
}));

test('a second concurrent writer fails closed with ControlSettingsLockedError', () => withTempSettingsPath((path) => {
  const deps = {
    openFn: () => { const err = new Error('locked'); err.code = 'EEXIST'; throw err; },
  };
  assert.throws(() => replaceControlSettingsDocument({ path, mutate: (agents) => agents, deps }), ControlSettingsLockedError);
}));

test('restart persistence: a brand-new store instance pointed at the same path reads the committed write', () => withTempSettingsPath((path) => {
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 1 } }) });
  // Simulate a fresh process: no shared in-memory state, just the file path.
  const reloaded = loadControlSettingsDocument(path);
  assert.equal(reloaded.revision, 1);
  assert.deepEqual(reloaded.doc.agents.a, { v: 1 });
}));

test('rollback restores a previous revision as a new, higher revision number', () => withTempSettingsPath((path) => {
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 1 } }) }); // rev 1
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 2 } }) }); // rev 2
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 3 } }) }); // rev 3

  const result = rollbackControlSettings({ path, targetRevision: 1 });
  assert.equal(result.restoredFromRevision, 1);
  assert.equal(result.revision, 4); // monotonic — never reuses revision 1
  assert.deepEqual(result.doc.agents.a, { v: 1 });

  const { doc } = loadControlSettingsDocument(path);
  assert.deepEqual(doc.agents.a, { v: 1 });
  assert.equal(doc.revision, 4);
}));

test('rollback to an unavailable/unknown revision fails closed without touching the current document', () => withTempSettingsPath((path) => {
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 1 } }) });
  assert.throws(() => rollbackControlSettings({ path, targetRevision: 999 }), ControlSettingsRollbackUnavailableError);
  const { doc } = loadControlSettingsDocument(path);
  assert.equal(doc.revision, 1);
  assert.deepEqual(doc.agents.a, { v: 1 });
}));

test('rollback to revision 0 restores the empty document', () => withTempSettingsPath((path) => {
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 1 } }) });
  const result = rollbackControlSettings({ path, targetRevision: 0 });
  assert.deepEqual(result.doc.agents, {});
}));

test('listControlSettingsHistory returns retained revisions, most recent first', () => withTempSettingsPath((path) => {
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 1 } }) });
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 2 } }) });
  const history = listControlSettingsHistory(path);
  assert.deepEqual(history, [1]);
}));

test('a failing write leaves the destination file untouched (structural rollback)', () => withTempSettingsPath((path) => {
  replaceControlSettingsDocument({ path, mutate: (agents) => ({ ...agents, a: { v: 1 } }) });
  const before = readFileSync(path, 'utf8');
  assert.throws(() => replaceControlSettingsDocument({
    path,
    mutate: (agents) => ({ ...agents, a: { v: 2 } }),
    deps: { renameFn: () => { throw new Error('simulated rename failure'); } },
  }));
  assert.equal(readFileSync(path, 'utf8'), before);
}));
