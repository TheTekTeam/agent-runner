import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertMandatoryQuotaPreflight,
  loadAgentRunnerConfig,
  resolveConfigPath,
} from './agent-runner-config.mjs';
import { parseArgs as parseCronArgs } from './claude-runner-cron.mjs';

test('mandatory quota guard rejects execute with the legacy CLI bypass before config resolution', () => {
  assert.throws(
    () => assertMandatoryQuotaPreflight({ argv: ['--execute', '--skip-quota-preflight'], env: {} }),
    /Quota preflight is mandatory in execute mode.*--skip-quota-preflight/,
  );
  assert.throws(
    () => resolveConfigPath(['--execute', '--skip-quota-preflight'], {}),
    /Quota preflight is mandatory in execute mode/,
  );
});

test('mandatory quota guard rejects execute with the legacy environment bypass without exposing its value', () => {
  const env = { CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: 'true' };
  assert.throws(
    () => loadAgentRunnerConfig({ argv: ['--execute'], env }),
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
    () => parseCronArgs(['--execute'], { CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: '1' }),
    /Quota preflight is mandatory in execute mode/,
  );
});

test('ordinary execute keeps quota preflight enabled and false-like legacy env values cannot disable it', () => {
  const ordinary = parseCronArgs(['--execute'], {});
  assert.equal(ordinary.execute, true);
  assert.equal(ordinary.quotaPreflight, true);

  for (const value of ['', '0', 'false', 'no', 'off']) {
    const parsed = parseCronArgs(['--execute'], { CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: value });
    assert.equal(parsed.execute, true);
    assert.equal(parsed.quotaPreflight, true);
  }
});

test('dry-run compatibility may retain the legacy skip controls because it cannot launch a provider or mutate a claim', () => {
  const cliDryRun = parseCronArgs(['--dry-run', '--skip-quota-preflight'], {});
  assert.equal(cliDryRun.execute, false);
  assert.equal(cliDryRun.quotaPreflight, false);

  const envDryRun = parseCronArgs([], { CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: 'true' });
  assert.equal(envDryRun.execute, false);
  assert.equal(envDryRun.quotaPreflight, false);
});
