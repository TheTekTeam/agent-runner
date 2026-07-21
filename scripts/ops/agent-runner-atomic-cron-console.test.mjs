import assert from 'node:assert/strict';
import test from 'node:test';

import { createStableOutputCapture } from './agent-runner-atomic-cron.mjs';

test('default capture sinks remain stable after globals are patched', () => {
  const directLogged = [];
  const directErrored = [];
  const originalLog = (...values) => directLogged.push(values);
  const originalError = (...values) => directErrored.push(values);
  const observed = [];
  const capture = createStableOutputCapture({
    originalConsoleLog: originalLog,
    originalConsoleError: originalError,
    onValues: (values) => observed.push(values),
  });

  const savedLog = console.log;
  const savedError = console.error;
  try {
    console.log = capture.directLog;
    console.error = capture.directError;
    capture.loggerLog('{"selectedIssue":686}');
    capture.loggerError('bounded scheduler error');
    console.log('{"directConsole":true}');
    console.error('direct console error');
  } finally {
    console.log = savedLog;
    console.error = savedError;
  }

  assert.deepEqual(directLogged, [
    ['{"selectedIssue":686}'],
    ['{"directConsole":true}'],
  ]);
  assert.deepEqual(directErrored, [
    ['bounded scheduler error'],
    ['direct console error'],
  ]);
  assert.deepEqual(observed, [
    ['{"selectedIssue":686}'],
    ['bounded scheduler error'],
    ['{"directConsole":true}'],
    ['direct console error'],
  ]);
});

test('custom logger capture stays separate from direct console capture', () => {
  const logged = [];
  const errored = [];
  const directLogged = [];
  const directErrored = [];
  const capture = createStableOutputCapture({
    logger: {
      log: (...values) => logged.push(values),
      error: (...values) => errored.push(values),
    },
    originalConsoleLog: (...values) => directLogged.push(values),
    originalConsoleError: (...values) => directErrored.push(values),
  });

  capture.loggerLog('logger output');
  capture.loggerError('logger error');
  capture.directLog('direct output');
  capture.directError('direct error');

  assert.deepEqual(logged, [['logger output']]);
  assert.deepEqual(errored, [['logger error']]);
  assert.deepEqual(directLogged, [['direct output']]);
  assert.deepEqual(directErrored, [['direct error']]);
});
