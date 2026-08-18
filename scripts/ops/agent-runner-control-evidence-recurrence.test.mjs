import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const recurrence = readFileSync(new URL('../../bin/run-implementation-recurrence.sh', import.meta.url), 'utf8');

test('generic Dell recurrence publishes bounded control evidence before source activation and candidate recurrence', () => {
  const publisherDecl = recurrence.indexOf('CONTROL_EVIDENCE_PUBLISHER=');
  const publisherRun = recurrence.indexOf('CONTROL_EVIDENCE_OUTPUT="$($NODE_BIN "$CONTROL_EVIDENCE_PUBLISHER" 2>&1)"');
  const sourceActivationRun = recurrence.indexOf('SOURCE_ACTIVATION_OUTPUT="$($NODE_BIN "$SOURCE_ACTIVATION_CONTROLLER" 2>&1)"');
  const candidateExec = recurrence.indexOf('exec "$NODE_BIN" "$RECURRENCE_SCRIPT"');

  assert.ok(publisherDecl >= 0, 'control evidence publisher must be declared');
  assert.ok(publisherRun > publisherDecl, 'control evidence publisher must be invoked');
  assert.ok(sourceActivationRun > publisherRun, 'evidence must publish before source activation');
  assert.ok(candidateExec > publisherRun, 'evidence must publish before candidate recurrence/lock acquisition');
});

test('control-evidence publication failure skips source activation and implementation work', () => {
  const failureGuard = recurrence.indexOf('if [ "$CONTROL_EVIDENCE_STATUS" -ne 0 ]; then');
  const skipMessage = recurrence.indexOf('control-evidence publication failed; implementation recurrence skipped');
  const guardExit = recurrence.indexOf('exit 0', skipMessage);
  const sourceActivationRun = recurrence.indexOf('SOURCE_ACTIVATION_OUTPUT="$($NODE_BIN "$SOURCE_ACTIVATION_CONTROLLER" 2>&1)"');
  const candidateExec = recurrence.indexOf('exec "$NODE_BIN" "$RECURRENCE_SCRIPT"');

  assert.ok(failureGuard >= 0, 'publisher failure guard must exist');
  assert.ok(skipMessage > failureGuard, 'publisher failure must have bounded skip reason');
  assert.ok(guardExit > skipMessage, 'publisher failure must terminate the recurrence as handled');
  assert.ok(guardExit < sourceActivationRun, 'publisher failure must exit before source activation');
  assert.ok(guardExit < candidateExec, 'publisher failure must exit before candidate execution');
});
