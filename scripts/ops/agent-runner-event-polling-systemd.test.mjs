import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const timer = readFileSync(new URL('../../systemd/user/agent-runner-event-polling.timer', import.meta.url), 'utf8');
const service = readFileSync(new URL('../../systemd/user/agent-runner-event-polling.service', import.meta.url), 'utf8');

test('polling timer schedules after service completion instead of activation', () => {
  assert.match(timer, /^OnUnitInactiveSec=1min$/m);
  assert.doesNotMatch(timer, /^OnUnitActiveSec=/m);
});

test('polling service delegates one bounded local-authority cycle', () => {
  assert.match(service, /agent-runner-queue-triage-local-authority\.mjs/);
  assert.doesNotMatch(service, /agent-runner-polling-controller-summary\.mjs/);
  assert.match(service, /^EnvironmentFile=-%h\/\.config\/agent-runner\/queue-triage-authority\.env$/m);
  assert.match(service, /--bootstrap-lookback-ms 86400000/);
  assert.match(service, /--batch-limit 25/);
  assert.match(service, /--all-enabled/);
  assert.match(service, /--execute/);
  assert.match(service, /^TimeoutStartSec=15min$/m);
});
