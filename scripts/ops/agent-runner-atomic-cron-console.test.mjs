import assert from 'node:assert/strict';
import test from 'node:test';

import { main } from './agent-runner-atomic-cron.mjs';

test('captures scheduler logger and direct console output without recursion', async () => {
  const logged = [];
  const errored = [];
  const originalLog = console.log;
  const originalError = console.error;

  const exitCode = await main([], {}, {
    parseArgs: () => ({ execute: false }),
    logger: {
      log: (...values) => logged.push(values),
      error: (...values) => errored.push(values),
    },
    schedulerMain: async (_argv, _env, dependencies) => {
      dependencies.logger.log('{"selectedIssue":686}');
      dependencies.logger.error('bounded scheduler error');
      console.log('{"directConsole":true}');
      console.error('direct console error');
      return 1;
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(logged, [['{"selectedIssue":686}']]);
  assert.deepEqual(errored, [['bounded scheduler error']]);
  assert.equal(console.log, originalLog);
  assert.equal(console.error, originalError);
});

test('restores console methods when scheduler throws', async () => {
  const originalLog = console.log;
  const originalError = console.error;

  await assert.rejects(() => main([], {}, {
    parseArgs: () => ({ execute: false }),
    logger: { log() {}, error() {} },
    schedulerMain: async () => {
      throw new Error('scheduler exploded');
    },
  }), /scheduler exploded/);

  assert.equal(console.log, originalLog);
  assert.equal(console.error, originalError);
});
