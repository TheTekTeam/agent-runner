import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('systemd units verify and installer preserves explicit activation and rollback gates', () => {
  const socketPath = new URL('../../systemd/user/agent-runner-event-ingress.socket', import.meta.url);
  const servicePath = new URL('../../systemd/user/agent-runner-event-ingress.service', import.meta.url);
  const verify = spawnSync('systemd-analyze', ['verify', socketPath.pathname, servicePath.pathname], {
    encoding: 'utf8',
  });
  if (verify.error?.code !== 'ENOENT') {
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  }

  const installer = readFileSync(new URL('../install-event-ingress-transport.sh', import.meta.url), 'utf8');
  assert.match(installer, /ACTION=.*install.*rollback/s);
  assert.match(installer, /--enable/);
  assert.match(installer, /backup_dir=/);
  assert.match(installer, /rollback_complete=true/);
  assert.match(installer, /secret_file_mode=/);
  assert.doesNotMatch(installer, /openssl rand|github.*webhook.*create|nginx -s|ufw|certbot/);
});
