import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const UNIT = readFileSync(path.join(ROOT, 'systemd/user/agent-runner-control.service.in'), 'utf8');
const INSTALLER = readFileSync(path.join(ROOT, 'scripts/install-control-dashboard.sh'), 'utf8');

const REQUIRED_HARDENING = [
  'NoNewPrivileges=true',
  'PrivateTmp=true',
  'ProtectSystem=strict',
  'ProtectHome=read-only',
  'ReadOnlyPaths=%h/.local/state/agent-runner',
  'ReadWritePaths=%h/.config/agent-runner',
  'ReadWritePaths=%h/.local/state/agent-runner/secrets',
  'ReadWritePaths=%h/.local/state/agent-runner/control-audit.jsonl',
  'RestrictAddressFamilies=AF_UNIX AF_INET',
  'LockPersonality=true',
  'RestrictRealtime=true',
  'RestrictSUIDSGID=true',
  'UMask=0077',
  'TasksMax=64',
  'MemoryMax=384M',
  'OOMPolicy=stop',
];

test('control service retains all compatible sandboxing while omitting the Node WebAssembly conflict', () => {
  assert.match(UNIT, /^ExecStart=@@NODE@@ @@SERVER@@ --port @@PORT@@$/m);
  assert.doesNotMatch(UNIT, /--jitless/);
  assert.doesNotMatch(UNIT, /^Environment=NODE_OPTIONS=/m);
  assert.doesNotMatch(UNIT, /^MemoryDenyWriteExecute=/m);

  for (const directive of REQUIRED_HARDENING) {
    assert.ok(UNIT.includes(directive), `missing compatible hardening directive: ${directive}`);
  }
});

test('installer rejects reintroduction of the incompatible executable-memory settings', () => {
  assert.match(INSTALLER, /ExecStart=\$NODE_BIN \$SERVER --port \$PORT/);
  assert.doesNotMatch(INSTALLER, /Environment=NODE_OPTIONS=--jitless/);
  assert.match(INSTALLER, /grep -Fq -- '--jitless'/);
  assert.match(INSTALLER, /grep -Eq '\^MemoryDenyWriteExecute='/);
  assert.match(INSTALLER, /MemoryDenyWriteExecute is incompatible with the approved Node\.js control runtime/);
});
