import assert from 'node:assert/strict';
import test from 'node:test';

import { main } from '../../.agent-runner/scripts/runner-cron.mjs';

test('portable cron returns handled pause before legacy scheduler delegation', async () => {
  const messages = [];
  let delegated = false;
  const code = await main(['--execute'], {}, {
    logger: { log: (message) => messages.push(JSON.parse(message)) },
    importModule: async () => {
      delegated = true;
      return { main: async () => 99 };
    },
  });

  assert.equal(code, 0);
  assert.equal(delegated, false);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].failureScope, 'machine_profile');
  assert.equal(messages[0].selectedIssue, null);
  assert.equal(messages[0].issueMutation, false);
  assert.equal(messages[0].childLaunched, false);
});

test('admitted portable cron disables generated preflight before delegation', async () => {
  let delegatedEnv = null;
  const code = await main(['--execute'], {
    CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true',
    CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola',
    CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION: 'false',
  }, {
    importModule: async () => ({
      main: async (_argv, env) => {
        delegatedEnv = env;
        return 0;
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(delegatedEnv.CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT, 'true');
  assert.equal(delegatedEnv.CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION, 'false');
});
