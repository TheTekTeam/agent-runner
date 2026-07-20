import assert from 'node:assert/strict';
import test from 'node:test';

import { runPortableEntrypoint } from './standalone-entrypoint.mjs';

const scriptUrl = new URL('./runner.mjs', import.meta.url).href;

test('dispatches once to the standalone checkout and preserves arguments', async () => {
  const calls = [];
  const code = await runPortableEntrypoint({
    scriptUrl,
    scriptName: 'runner.mjs',
    legacyModuleUrl: 'file:///legacy.mjs',
    argv: ['--help'],
    env: { SAFE: '1' },
    dependencies: {
      resolveStandaloneTarget: () => ({
        currentRoot: '/modelspend',
        standaloneRoot: '/agent-runner',
        target: '/agent-runner/.agent-runner/scripts/runner.mjs',
        shouldDispatch: true,
      }),
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 7 };
      },
      importModule: async () => {
        throw new Error('local implementation must not load after dispatch');
      },
    },
  });

  assert.equal(code, 7);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['/agent-runner/.agent-runner/scripts/runner.mjs', '--help']);
  assert.equal(calls[0].options.env.AGENT_RUNNER_STANDALONE_DISPATCHED, '1');
  assert.equal(calls[0].options.env.AGENT_RUNNER_HOME, '/agent-runner');
});

test('uses the proven local implementation when standalone source is absent', async () => {
  const calls = [];
  const code = await runPortableEntrypoint({
    scriptUrl,
    scriptName: 'runner-cron.mjs',
    legacyModuleUrl: 'file:///legacy.mjs',
    argv: ['--dry-run'],
    env: { SAFE: '1' },
    dependencies: {
      resolveStandaloneTarget: () => ({ shouldDispatch: false }),
      spawnSync: () => {
        throw new Error('standalone process must not start');
      },
      importModule: async (url) => ({
        main: async (argv, env) => {
          calls.push({ url, argv, env });
          return 3;
        },
      }),
    },
  });

  assert.equal(code, 3);
  assert.deepEqual(calls, [{
    url: 'file:///legacy.mjs',
    argv: ['--dry-run'],
    env: { SAFE: '1' },
  }]);
});

test('a dispatched process cannot recursively dispatch again', async () => {
  let imported = false;
  const code = await runPortableEntrypoint({
    scriptUrl,
    scriptName: 'runner.mjs',
    legacyModuleUrl: 'file:///legacy.mjs',
    argv: [],
    env: { AGENT_RUNNER_STANDALONE_DISPATCHED: '1' },
    dependencies: {
      resolveStandaloneTarget: () => ({ shouldDispatch: false }),
      importModule: async () => ({
        main: async () => {
          imported = true;
          return 0;
        },
      }),
    },
  });
  assert.equal(code, 0);
  assert.equal(imported, true);
});
