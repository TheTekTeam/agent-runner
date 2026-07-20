import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./agent-runner-admission.mjs', import.meta.url);

function run(env = {}) {
  return spawnSync(process.execPath, [script.pathname, '--execute'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('admission CLI returns handled profile-pause status before selection', () => {
  const result = run();
  assert.equal(result.status, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureScope, 'machine_profile');
  assert.equal(payload.selectedIssue, null);
  assert.equal(payload.issueMutation, false);
  assert.equal(payload.childLaunched, false);
  assert.equal(payload.systemdOutcome, 'handled');
});

test('admission CLI permits a valid machine profile', () => {
  const result = run({
    CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
    CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
    CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION: 'false',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
