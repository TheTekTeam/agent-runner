import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const WRAPPER = resolve(HERE, '../../bin/run-implementation-recurrence.sh');

test('implementation wrapper invokes bounded source recovery only from handled source-authority halt', () => {
  const source = readFileSync(WRAPPER, 'utf8');

  assert.match(source, /SOURCE_ACTIVATION_RECOVERY=.*agent-runner-source-activation-recovery\.mjs/);
  assert.match(source, /case "\$SOURCE_ACTIVATION_STATUS" in[\s\S]*?3\)[\s\S]*?SOURCE_RECOVERY_OUTPUT=/);
  assert.match(source, /case "\$SOURCE_RECOVERY_STATUS" in[\s\S]*?10\)[\s\S]*?source_activation_reexec/);
  assert.match(source, /0\|3\)\s*\n\s*;;/);
  assert.match(source, /source_activation_reexec\(\)[\s\S]*?AGENT_RUNNER_SOURCE_ACTIVATION_REEXEC_DEPTH=1/);

  const recoveryCall = source.indexOf('SOURCE_RECOVERY_OUTPUT=');
  const authorityHaltCase = source.indexOf('    3)');
  const candidateExec = source.indexOf('exec "$NODE_BIN" "$RECURRENCE_SCRIPT"');
  assert.ok(authorityHaltCase >= 0 && recoveryCall > authorityHaltCase, 'recovery must be inside the handled authority-halt branch');
  assert.ok(candidateExec > recoveryCall, 'recovery must complete before candidate selection can execute');
});
