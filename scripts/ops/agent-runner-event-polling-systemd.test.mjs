import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const timer = readFileSync(new URL('../../systemd/user/agent-runner-event-polling.timer', import.meta.url), 'utf8');
const service = readFileSync(new URL('../../systemd/user/agent-runner-event-polling.service', import.meta.url), 'utf8');

test('polling timer schedules after service completion instead of activation', () => {
  assert.match(timer, /^OnUnitInactiveSec=1min$/m);
  assert.doesNotMatch(timer, /^OnUnitActiveSec=/m);
});

test('polling service uses bounded bootstrap, batch and compact output settings', () => {
  assert.match(service, /agent-runner-polling-controller-summary\.mjs/);
  assert.match(service, /--bootstrap-lookback-ms 86400000/);
  assert.match(service, /--batch-limit 25/);
  assert.match(service, /^TimeoutStartSec=5min$/m);
});
