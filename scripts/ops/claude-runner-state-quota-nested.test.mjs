import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openRunnerStateStore } from './claude-runner-state.mjs';

test('runner state persists the real nested quota-check payload shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-nested-quota-'));
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-17T15:54:55.388Z' });
  try {
    store.recordQuotaHistory({
      repo: 'TheTekTeam/modelspend',
      quotaPreflight: {
        blocked: false,
        skipped: false,
        status: 'available',
        payload: {
          checked: true,
          status: 'available',
          state: {
            status: 'available',
            sessionPercentUsed: 0,
            weeklyPercentUsed: 52,
            quotaUsage: {
              session: { usedPercent: 0, resetAt: '2026-07-17T18:00:00.000Z' },
              week: { usedPercent: 52, resetAt: '2026-07-20T18:00:00.000Z' },
            },
          },
        },
      },
    });

    const row = store.allRows('quota_history')[0];
    assert.equal(row.status, 'available');
    assert.equal(row.session_usage_percent, 0);
    assert.equal(row.weekly_usage_percent, 52);
    assert.equal(row.reset_at, '2026-07-17T18:00:00.000Z');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner state keeps backwards compatibility with normalized quotaUsage-only payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-normalized-quota-'));
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath);
  try {
    store.recordQuotaHistory({
      repo: 'TheTekTeam/modelspend',
      quotaPreflight: {
        status: 'available',
        payload: {
          quotaUsage: {
            session: { usedPercent: 23 },
            week: { usedPercent: 41 },
          },
        },
      },
    });
    const row = store.allRows('quota_history')[0];
    assert.equal(row.session_usage_percent, 23);
    assert.equal(row.weekly_usage_percent, 41);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
