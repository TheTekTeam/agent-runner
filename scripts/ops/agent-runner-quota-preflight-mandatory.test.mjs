import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertMandatoryQuotaPreflight,
  loadAgentRunnerConfig,
  resolveConfigPath,
} from './agent-runner-config.mjs';
import { parseArgs as parseCronArgs } from './claude-runner-cron.mjs';

test('mandatory quota guard rejects CLI execute with the legacy CLI bypass before config resolution', () => {
  assert.throws(
    () => assertMandatoryQuotaPreflight({ argv: ['--execute', '--skip-quota-preflight'], env: {} }),
    /Quota preflight is mandatory in execute mode.*--skip-quota-preflight/,
  );
  assert.throws(
    () => resolveConfigPath(['--execute', '--skip-quota-preflight'], {}),
    /Quota preflight is mandatory in execute mode/,
  );
});

test('mandatory quota guard rejects service execute mode with the legacy environment bypass without exposing its value', () => {
  const env = {
    CLAUDE_RUNNER_CRON_EXECUTE: 'true',
    CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: 'true',
  };
  assert.throws(
    () => loadAgentRunnerConfig({ argv: [], env }),
    (error) => {
      assert.match(error.message, /Quota preflight is mandatory in execute mode/);
      assert.match(error.message, /CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT/);
      assert.ok(!error.message.includes('=true'));
      return true;
    },
  );
});

test('cron parseArgs cannot construct an executing scheduler pass with either legacy quota bypass', () => {
  assert.throws(
    () => parseCronArgs(['--execute', '--skip-quota-preflight'], {}),
    /Quota preflight is mandatory in execute mode/,
  );
  assert.throws(
    () => parseCronArgs([], {
      CLAUDE_RUNNER_CRON_EXECUTE: '1',
      CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: '1',
    }),
    /Quota preflight is mandatory in execute mode/,
  );
  assert.throws(
    () => parseCronArgs(['--skip-quota-preflight'], { CLAUDE_RUNNER_CRON_EXECUTE: 'yes' }),
    /Quota preflight is mandatory in execute mode/,
  );
});

test('ordinary CLI and service execute modes keep quota preflight enabled', () => {
  const cliExecute = parseCronArgs(['--execute'], {});
  assert.equal(cliExecute.execute, true);
  assert.equal(cliExecute.quotaPreflight, true);

  const serviceExecute = parseCronArgs([], { CLAUDE_RUNNER_CRON_EXECUTE: 'true' });
  assert.equal(serviceExecute.execute, true);
  assert.equal(serviceExecute.quotaPreflight, true);

  for (const value of ['', '0', 'false', 'no', 'off']) {
    const parsed = parseCronArgs([], {
      CLAUDE_RUNNER_CRON_EXECUTE: 'true',
      CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: value,
    });
    assert.equal(parsed.execute, true);
    assert.equal(parsed.quotaPreflight, true);
  }
});

test('explicit dry-run overrides service execute env and may retain legacy skip controls as mutation-free diagnostics', () => {
  const cliDryRun = parseCronArgs(['--dry-run', '--skip-quota-preflight'], { CLAUDE_RUNNER_CRON_EXECUTE: 'true' });
  assert.equal(cliDryRun.execute, false);
  assert.equal(cliDryRun.quotaPreflight, false);

  const envDryRun = parseCronArgs([], { CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: 'true' });
  assert.equal(envDryRun.execute, false);
  assert.equal(envDryRun.quotaPreflight, false);
});
