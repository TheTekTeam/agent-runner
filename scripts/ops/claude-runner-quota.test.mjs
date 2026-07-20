import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT,
  MIN_QUOTA_BACKOFF_MS,
  buildQuotaCheckArgs,
  computeQuotaBackoffMs,
  detectQuotaExhaustion,
  evaluateQuotaPauseState,
  formatQuotaUsage,
  parseClaudeUsageOutput,
  parseClaudeUsageSession,
  parseQuotaCheckOutput,
  parseQuotaResetTime,
  recordQuotaPause,
} from './claude-runner-quota.mjs';

const SAMPLE_USAGE_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 43% used · resets Jul 8, 10:19pm (UTC)
Current week (all models): 52% used · resets Jul 11, 5:59pm (UTC)
Current week (Fable): 0% used
`;

const CURRENT_ZERO_SESSION_USAGE_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 0% used
Current week (all models): 52% used · resets Jul 11, 6pm (UTC)
Current week (Fable): 0% used

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 384 requests · 5 sessions
  72% of your usage was at >150k context
  12% of your usage came from subagent-heavy sessions
  Top subagents: explore 2%

Last 7d · 6490 requests · 75 sessions
  67% of your usage was at >150k context
  39% of your usage came from subagent-heavy sessions
  Top subagents: code-review 1%, explore 1%`;

test('detects common quota-exhausted and rate-limit phrasing', () => {
  assert.equal(detectQuotaExhaustion('Error: usage limit reached. Please try again later.').exhausted, true);
  assert.equal(detectQuotaExhaustion('rate limit exceeded, retry after some time').exhausted, true);
  assert.equal(detectQuotaExhaustion('Your 5-hour limit reached at 10:00').exhausted, true);
  assert.equal(detectQuotaExhaustion('Task completed successfully with no issues.').exhausted, false);
});

test('parses a precise reset time when present and plausible', () => {
  const now = new Date('2026-07-08T12:00:00Z');
  const resetAt = parseQuotaResetTime('Usage limit reached. Limit resets at 2026-07-08T18:00:00Z', { now });
  assert.ok(resetAt instanceof Date);
  assert.equal(resetAt.toISOString(), '2026-07-08T18:00:00.000Z');
});

test('parses Claude Code /usage current-session reset output', () => {
  const now = new Date('2026-07-08T19:20:00Z');
  const usage = parseClaudeUsageSession(SAMPLE_USAGE_OUTPUT, { now });
  assert.equal(usage.percentUsed, 43);
  assert.equal(usage.resetAt.toISOString(), '2026-07-08T22:19:00.000Z');
});

test('parses full Claude Code /usage output into structured fields', () => {
  const now = new Date('2026-07-08T23:17:00Z');
  const usage = parseClaudeUsageOutput(CURRENT_ZERO_SESSION_USAGE_OUTPUT, { now });
  assert.equal(usage.currentSession.percentUsed, 0);
  assert.equal(usage.currentSession.resetAt, null);
  assert.equal(usage.currentWeek.percentUsed, 52);
  assert.equal(usage.currentWeek.resetAt.toISOString(), '2026-07-11T18:00:00.000Z');
  assert.equal(usage.modelWeeks.Fable.percentUsed, 0);
  assert.equal(usage.linesParsed, 3);
});

test('formats parsed Claude usage into compact dashboard-friendly quotaUsage', () => {
  const now = new Date('2026-07-08T23:17:00Z');
  const usage = parseClaudeUsageOutput(CURRENT_ZERO_SESSION_USAGE_OUTPUT, { now });
  assert.deepEqual(formatQuotaUsage(usage), {
    session: {
      usedPercent: 0,
      resetAt: null,
      resetText: null,
    },
    week: {
      usedPercent: 52,
      resetAt: '2026-07-11T18:00:00.000Z',
      resetText: 'Jul 11, 6pm (UTC)',
    },
    models: {
      Fable: {
        usedPercent: 0,
        resetAt: null,
        resetText: null,
      },
    },
    linesParsed: 3,
  });
});

test('parseQuotaResetTime can read Claude Code /usage reset output', () => {
  const now = new Date('2026-07-08T19:20:00Z');
  const resetAt = parseQuotaResetTime(SAMPLE_USAGE_OUTPUT, { now });
  assert.equal(resetAt.toISOString(), '2026-07-08T22:19:00.000Z');
});

test('parseQuotaResetTime falls back to weekly reset when session reset is absent', () => {
  const now = new Date('2026-07-08T23:17:00Z');
  const resetAt = parseQuotaResetTime(CURRENT_ZERO_SESSION_USAGE_OUTPUT, { now });
  assert.equal(resetAt.toISOString(), '2026-07-11T18:00:00.000Z');
});

test('fails closed (returns null) when no reset time is present', () => {
  const resetAt = parseQuotaResetTime('Usage limit reached. Try again soon.', { now: new Date('2026-07-08T12:00:00Z') });
  assert.equal(resetAt, null);
});

test('fails closed when the parsed reset time is implausible', () => {
  const now = new Date('2026-07-08T12:00:00Z');
  const resetAt = parseQuotaResetTime('Limit resets at 1999-01-01T00:00:00Z', { now });
  assert.equal(resetAt, null);
});

test('computeQuotaBackoffMs enforces at least the minimum backoff', () => {
  const now = new Date('2026-07-08T12:00:00Z');
  assert.equal(computeQuotaBackoffMs({ resetAt: null, now }), MIN_QUOTA_BACKOFF_MS);
  const soonReset = new Date(now.getTime() + 60 * 1000);
  assert.equal(computeQuotaBackoffMs({ resetAt: soonReset, now }), MIN_QUOTA_BACKOFF_MS);
});

test('computeQuotaBackoffMs uses the precise reset time when it is later than the minimum', () => {
  const now = new Date('2026-07-08T12:00:00Z');
  const laterReset = new Date(now.getTime() + 60 * 60 * 1000);
  assert.equal(computeQuotaBackoffMs({ resetAt: laterReset, now }), 60 * 60 * 1000);
});

test('recordQuotaPause produces a pausedUntil at least the minimum backoff away', () => {
  const now = new Date('2026-07-08T12:00:00Z');
  const pause = recordQuotaPause({ reason: 'quota-exhausted', now });
  assert.equal(pause.pausedUntil, new Date(now.getTime() + MIN_QUOTA_BACKOFF_MS).toISOString());
  assert.equal(pause.reason, 'quota-exhausted');
});

test('evaluateQuotaPauseState reports paused while pausedUntil is in the future', () => {
  const now = new Date('2026-07-08T12:00:00Z');
  const state = { pausedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(), reason: 'quota-exhausted' };
  const result = evaluateQuotaPauseState(state, { now });
  assert.equal(result.paused, true);
  assert.equal(result.reason, 'quota-exhausted');
});

test('evaluateQuotaPauseState reports not paused once pausedUntil has passed', () => {
  const now = new Date('2026-07-08T12:00:00Z');
  const state = { pausedUntil: new Date(now.getTime() - 1000).toISOString() };
  const result = evaluateQuotaPauseState(state, { now });
  assert.equal(result.paused, false);
  assert.equal(result.dueForRecheck, true);
});

test('evaluateQuotaPauseState treats missing or corrupt state as not paused', () => {
  assert.equal(evaluateQuotaPauseState(null).paused, false);
  assert.equal(evaluateQuotaPauseState({ pausedUntil: 'not-a-date' }).paused, false);
});

test('parseQuotaCheckOutput treats Claude Code /usage below start threshold as available', () => {
  const result = parseQuotaCheckOutput(SAMPLE_USAGE_OUTPUT, { now: new Date('2026-07-08T19:20:00Z') });
  assert.equal(result.status, 'available');
  assert.equal(result.matchedPattern, 'claude-usage-current-session');
  assert.equal(result.percentUsed, 43);
  assert.equal(result.sessionPercentUsed, 43);
  assert.equal(result.weeklyPercentUsed, 52);
  assert.equal(result.resetAt.toISOString(), '2026-07-08T22:19:00.000Z');
  assert.deepEqual(result.quotaUsage.session, {
    usedPercent: 43,
    resetAt: '2026-07-08T22:19:00.000Z',
    resetText: 'Jul 8, 10:19pm (UTC)',
  });
});

test('parseQuotaCheckOutput treats current Claude Code zero-session output as available', () => {
  const result = parseQuotaCheckOutput(CURRENT_ZERO_SESSION_USAGE_OUTPUT, { now: new Date('2026-07-08T23:17:00Z') });
  assert.equal(result.status, 'available');
  assert.equal(result.matchedPattern, 'claude-usage-current-session');
  assert.equal(result.percentUsed, 0);
  assert.equal(result.sessionPercentUsed, 0);
  assert.equal(result.weeklyPercentUsed, 52);
  assert.equal(result.weeklyResetAt.toISOString(), '2026-07-11T18:00:00.000Z');
  assert.deepEqual(result.modelWeekPercentUsed, { Fable: 0 });
  assert.deepEqual(result.quotaUsage.week, {
    usedPercent: 52,
    resetAt: '2026-07-11T18:00:00.000Z',
    resetText: 'Jul 11, 6pm (UTC)',
  });
});

test('parseQuotaCheckOutput treats Claude Code /usage at 100 percent as exhausted until reset', () => {
  const output = 'Current session: 100% used · resets Jul 8, 10:19pm (UTC)';
  const result = parseQuotaCheckOutput(output, { now: new Date('2026-07-08T19:20:00Z') });
  assert.equal(result.status, 'exhausted');
  assert.equal(result.matchedPattern, 'claude-usage-current-session-100-percent');
  assert.equal(result.resetAt.toISOString(), '2026-07-08T22:19:00.000Z');
});

test('parseQuotaCheckOutput treats high Claude Code /usage as exhausted before starting new work', () => {
  const output = 'Current session: 90% used · resets Jul 8, 10:19pm (UTC)';
  // now is an injected fixed clock, not the real one — this test is
  // deterministic regardless of wall-clock time (#698 finding 8 re-review).
  const result = parseQuotaCheckOutput(output, { now: new Date('2026-07-08T19:20:00Z') });
  assert.equal(result.status, 'exhausted');
  assert.equal(result.matchedPattern, 'claude-usage-current-session-above-start-threshold');
  assert.equal(result.percentUsed, 90);
  // Asserted against the source constant, not a hard-coded literal, so this
  // can never drift stale again the way it did when the default threshold
  // was intentionally lowered from 85% to 50% (#706) but this expectation
  // was left behind.
  assert.equal(result.maxSessionUsageBeforeStartPercent, DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT);
  assert.equal(result.resetAt.toISOString(), '2026-07-08T22:19:00.000Z');
});

test('parseQuotaCheckOutput supports a custom high-usage start threshold', () => {
  const output = 'Current session: 70% used · resets Jul 8, 10:19pm (UTC)';
  const result = parseQuotaCheckOutput(output, { now: new Date('2026-07-08T19:20:00Z'), maxSessionUsageBeforeStartPercent: 70 });
  assert.equal(result.status, 'exhausted');
  assert.equal(result.maxSessionUsageBeforeStartPercent, 70);
});

test('parseQuotaCheckOutput treats the old unsupported /quota command as non-blocking', () => {
  const result = parseQuotaCheckOutput('Unknown command: /quota');
  assert.equal(result.status, 'available');
  assert.equal(result.matchedPattern, 'unsupported-legacy-quota-command');
  assert.equal(result.quotaUsage, null);
});

test('parseQuotaCheckOutput fails closed to ambiguous when neither signal is present', () => {
  const result = parseQuotaCheckOutput('Some unrelated CLI banner text.');
  assert.equal(result.status, 'ambiguous');
});

test('parseQuotaCheckOutput recognises exhausted and available signals', () => {
  assert.equal(parseQuotaCheckOutput('quota exhausted, try again later').status, 'exhausted');
  assert.equal(parseQuotaCheckOutput('quota available, remaining: 42').status, 'available');
});

test('buildQuotaCheckArgs builds a conservative print-mode usage query', () => {
  const args = buildQuotaCheckArgs({});
  assert.deepEqual(args, ['-p', '--output-format', 'text', '--permission-mode', 'plan', '/usage']);
});
