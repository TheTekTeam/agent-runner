import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appendControlAuditEntry, readControlAuditEntries, resolveControlAuditPath } from './agent-runner-control-audit.mjs';

function withTempAuditPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-control-audit-'));
  try {
    return fn(join(dir, 'nested', 'control-audit.jsonl'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveControlAuditPath defaults under the XDG state path', () => {
  const path = resolveControlAuditPath({ HOME: '/home/example' });
  assert.equal(path, '/home/example/.local/state/agent-runner/control-audit.jsonl');
});

test('resolveControlAuditPath honours an explicit override', () => {
  const path = resolveControlAuditPath({ HOME: '/home/example', AGENT_RUNNER_CONTROL_AUDIT_PATH: '/etc/agent-runner/audit.jsonl' });
  assert.equal(path, '/etc/agent-runner/audit.jsonl');
});

test('appendControlAuditEntry requires actor/source/action', () => withTempAuditPath((path) => {
  assert.throws(() => appendControlAuditEntry({ source: 's', action: 'a', path }), /actor/);
  assert.throws(() => appendControlAuditEntry({ actor: 'op', action: 'a', path }), /source/);
  assert.throws(() => appendControlAuditEntry({ actor: 'op', source: 's', path }), /action/);
}));

test('appendControlAuditEntry writes a mode-0600 file containing only field names, never a value', () => withTempAuditPath((path) => {
  const entry = appendControlAuditEntry({
    actor: 'operator',
    source: 'control-api',
    action: 'instance.settings.update',
    revision: 3,
    changedFields: ['agents.claude-code-cli.model'],
    path,
  });
  assert.equal(entry.actor, 'operator');
  assert.equal(entry.revision, 3);
  assert.deepEqual(entry.changedFields, ['agents.claude-code-cli.model']);
  assert.equal(entry.outcome, 'ok');

  const stats = statSync(path);
  assert.equal(stats.mode & 0o777, 0o600);

  const raw = readFileSync(path, 'utf8');
  assert.ok(!/secret-value|s3cr3t|password/i.test(raw));
  const parsed = JSON.parse(raw.trim());
  assert.deepEqual(Object.keys(parsed).sort(), ['action', 'actor', 'at', 'changedFields', 'id', 'outcome', 'reason', 'revision', 'source']);
}));

test('changedFields structurally cannot carry a value — a value-bearing object coerces to a fixed placeholder, never its content', () => withTempAuditPath((path) => {
  const injected = 'unit-test-secret-should-not-appear-verbatim';
  const entry = appendControlAuditEntry({
    actor: 'operator',
    source: 'control-api',
    action: 'secret.create',
    changedFields: [{ field: 'model', value: injected }, 'ok-field'],
    path,
  });
  // `String({...})` always yields the fixed literal "[object Object]" —
  // there is no way for an object's property values to reach the sanitized
  // array, only a caller passing an actual string field name does.
  assert.deepEqual(entry.changedFields, ['[object Object]', 'ok-field']);
  assert.ok(!JSON.stringify(entry).includes(injected));
}));

test('readControlAuditEntries returns most-recent-first and tolerates a missing file', () => withTempAuditPath((path) => {
  assert.deepEqual(readControlAuditEntries({ path }), []);
  appendControlAuditEntry({ actor: 'op', source: 's', action: 'first', path });
  appendControlAuditEntry({ actor: 'op', source: 's', action: 'second', path });
  const entries = readControlAuditEntries({ path });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'second');
  assert.equal(entries[1].action, 'first');
}));

test('readControlAuditEntries skips a corrupt line rather than failing the whole read', () => withTempAuditPath((path) => {
  appendControlAuditEntry({ actor: 'op', source: 's', action: 'first', path });
  const deps = {
    existsFn: () => true,
    readFn: () => `${JSON.stringify({ action: 'first' })}\nnot json\n${JSON.stringify({ action: 'third' })}\n`,
  };
  const entries = readControlAuditEntries({ path, deps });
  assert.deepEqual(entries.map((entry) => entry.action), ['third', 'first']);
}));
