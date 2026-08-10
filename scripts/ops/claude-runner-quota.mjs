// Quota-aware pausing helpers for the Claude runner.
//
// Scheduling only: this module never bypasses, evades, rotates, or works
// around Claude usage limits. It only detects exhaustion signals in Claude
// CLI output and computes a conservative, fail-closed pause window so the
// runner stops retrying until quota is plausibly available again.

export const MIN_QUOTA_BACKOFF_MS = 10 * 60 * 1000;
// Preserve half of the rolling session allowance by default. The previous
// 85% admission threshold allowed a second unattended run to start at 56%
// and consume the remaining allowance during the #599 invalid dispatch.
export const DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT = 50;
const MAX_PLAUSIBLE_RESET_MS = 30 * 24 * 60 * 60 * 1000;

// Closed task-profile vocabulary (#44). Mirrors claude-runner.mjs's PROFILE_NAMES;
// duplicated (not imported) to avoid a circular dependency on this module.
export const QUOTA_PROFILE_NAMES = Object.freeze(['docs', 'narrow', 'complex', 'critical']);

// Conservative repository-default session-usage ceiling per profile (#44): a
// cheaper profile can't be starved by a large in-flight critical candidate.
export const DEFAULT_PROFILE_SESSION_USAGE_THRESHOLDS = Object.freeze({
  docs: 90,
  narrow: 75,
  complex: 65,
  critical: DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT,
});

const MONTHS = new Map([
  ['jan', 0], ['january', 0],
  ['feb', 1], ['february', 1],
  ['mar', 2], ['march', 2],
  ['apr', 3], ['april', 3],
  ['may', 4],
  ['jun', 5], ['june', 5],
  ['jul', 6], ['july', 6],
  ['aug', 7], ['august', 7],
  ['sep', 8], ['sept', 8], ['september', 8],
  ['oct', 9], ['october', 9],
  ['nov', 10], ['november', 10],
  ['dec', 11], ['december', 11],
]);

const QUOTA_EXHAUSTION_PATTERNS = [
  /quota[\s_-]*exhausted/i,
  /quota[\s_-]*exceeded/i,
  /usage limit reached/i,
  /you(?:'|’)ve (?:hit|reached) your (?:usage|rate|weekly|5-hour) limit/i,
  /rate[\s_-]*limit(?:ed|\s*exceeded)?/i,
  /\b429\b.*rate/i,
  /please try again later/i,
  /5-hour limit reached/i,
  /weekly limit reached/i,
  /limit will reset/i,
];

const QUOTA_AVAILABLE_PATTERNS = [
  /quota available/i,
  /usage:\s*\d{1,3}%/i,
  /remaining:\s*\d+/i,
];

const RESET_TIME_PATTERNS = [
  /reset[s]?\s*(?:at|on)?\s*:?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i,
];

const CLAUDE_USAGE_SESSION_PATTERN = /Current session:\s*(\d{1,3})%\s*used(?:\s*·\s*resets\s+([^\n]+))?/i;
const CLAUDE_USAGE_LINE_PATTERN = /^Current\s+(session|week(?:\s*\(([^)]+)\))?):\s*(\d{1,3})%\s*used(?:\s*·\s*resets\s+(.+))?$/i;
const LEGACY_QUOTA_UNSUPPORTED_PATTERN = /Unknown command:\s*\/quota/i;

function plausibleResetOrNull(parsed, { now }) {
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) return null;
  let candidate = parsed;
  let diffMs = candidate.getTime() - now.getTime();
  if (diffMs < -MAX_PLAUSIBLE_RESET_MS) {
    candidate = new Date(Date.UTC(
      candidate.getUTCFullYear() + 1,
      candidate.getUTCMonth(),
      candidate.getUTCDate(),
      candidate.getUTCHours(),
      candidate.getUTCMinutes(),
      candidate.getUTCSeconds(),
      candidate.getUTCMilliseconds(),
    ));
    diffMs = candidate.getTime() - now.getTime();
  }
  if (diffMs < -MAX_PLAUSIBLE_RESET_MS || diffMs > MAX_PLAUSIBLE_RESET_MS) return null;
  return candidate;
}

function isoOrNull(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

function parseClaudeUsageResetText(resetText = '', { now = new Date() } = {}) {
  const value = String(resetText || '').trim();
  const match = value.match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\((UTC)\)|UTC)?/i);
  if (!match) return null;

  const month = MONTHS.get(match[1].toLowerCase());
  if (month === undefined) return null;

  const day = Number.parseInt(match[2], 10);
  let hour = Number.parseInt(match[3], 10);
  const minute = match[4] ? Number.parseInt(match[4], 10) : 0;
  const meridiem = match[5].toLowerCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
  if (meridiem === 'pm') hour = hour === 12 ? 12 : hour + 12;

  const parsed = new Date(Date.UTC(now.getUTCFullYear(), month, day, hour, minute, 0, 0));
  return plausibleResetOrNull(parsed, { now });
}

function normalizeStartThreshold(value, fallback = DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return fallback;
  return parsed;
}

// Machine-local-only ceiling override (#44): only an explicit
// `CLAUDE_RUNNER_MAX_SESSION_USAGE_BEFORE_START_PERCENT_<PROFILE>` env var can
// raise or lower a profile's repository-default ceiling; never issue/repo-derived.
export function resolveProfileSessionUsageThreshold(profileName, env = process.env) {
  const fallback = DEFAULT_PROFILE_SESSION_USAGE_THRESHOLDS[profileName] ?? DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT;
  const envKey = `CLAUDE_RUNNER_MAX_SESSION_USAGE_BEFORE_START_PERCENT_${String(profileName || '').toUpperCase()}`;
  return normalizeStartThreshold(env?.[envKey], fallback);
}

// Profile-aware admission decision from already-fetched fresh quota evidence
// (#44, scheduling only -- never spawns a process). Ambiguous/missing usage fails closed.
export function evaluateProfileQuotaAdmission({ quotaUsage = null, status = null, profileName, env = process.env } = {}) {
  const threshold = resolveProfileSessionUsageThreshold(profileName, env);
  const sessionPercentUsed = quotaUsage?.session?.usedPercent;

  if (status === 'ambiguous') {
    return { allowed: false, profile: profileName, threshold, sessionPercentUsed: sessionPercentUsed ?? null, status: 'ambiguous', reason: 'quota-evidence-ambiguous' };
  }
  if (!Number.isInteger(sessionPercentUsed)) {
    return { allowed: false, profile: profileName, threshold, sessionPercentUsed: null, status: 'unavailable', reason: 'quota-evidence-unavailable' };
  }
  if (sessionPercentUsed >= threshold) {
    return { allowed: false, profile: profileName, threshold, sessionPercentUsed, status: 'exhausted', reason: 'profile-session-usage-threshold-exceeded' };
  }
  return { allowed: true, profile: profileName, threshold, sessionPercentUsed, status: 'available', reason: null };
}

// Whether at least one profile could still be admitted from this pass's fresh
// evidence (#44) -- decides whether an over-threshold `critical` signal idles the
// whole queue, or whether per-candidate admission keeps scanning for smaller work.
export function anyProfileQuotaAdmissible({ quotaUsage = null, status = null, env = process.env, profileNames = QUOTA_PROFILE_NAMES } = {}) {
  return profileNames.some((profileName) => evaluateProfileQuotaAdmission({ quotaUsage, status, profileName, env }).allowed);
}

// Translates a `runQuotaPreflight()` result into the `{ quotaUsage, status }` shape
// both admission gates share (#44). `null` when skipped (opt-out); a missing/unparsed
// payload normalizes to 'ambiguous', which fails closed for every profile.
export function quotaAdmissionEvidenceFromPreflight(quotaPreflight) {
  if (!quotaPreflight || quotaPreflight.skipped) return null;
  return {
    quotaUsage: quotaPreflight.payload?.state?.quotaUsage ?? null,
    status: quotaPreflight.payload?.status ?? 'ambiguous',
  };
}

function parsePercent(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) return null;
  return parsed;
}

export function detectQuotaExhaustion(text = '') {
  const value = String(text || '');
  for (const pattern of QUOTA_EXHAUSTION_PATTERNS) {
    if (pattern.test(value)) {
      return { exhausted: true, matchedPattern: pattern.source };
    }
  }
  return { exhausted: false, matchedPattern: null };
}

export function parseClaudeUsageSession(text = '', { now = new Date() } = {}) {
  const value = String(text || '');
  const match = value.match(CLAUDE_USAGE_SESSION_PATTERN);
  if (!match) return null;
  const percentUsed = parsePercent(match[1]);
  if (percentUsed === null) return null;
  return {
    percentUsed,
    resetAt: match[2] ? parseClaudeUsageResetText(match[2], { now }) : null,
  };
}

export function parseClaudeUsageOutput(text = '', { now = new Date() } = {}) {
  const value = String(text || '');
  const usage = {
    currentSession: null,
    currentWeek: null,
    modelWeeks: {},
    linesParsed: 0,
  };

  for (const line of value.split(/\r?\n/)) {
    const match = line.trim().match(CLAUDE_USAGE_LINE_PATTERN);
    if (!match) continue;

    const rawKind = match[1].toLowerCase();
    const modelName = match[2] ? match[2].trim() : null;
    const percentUsed = parsePercent(match[3]);
    if (percentUsed === null) continue;

    const entry = {
      percentUsed,
      resetAt: match[4] ? parseClaudeUsageResetText(match[4], { now }) : null,
      resetText: match[4] ? match[4].trim() : null,
    };

    usage.linesParsed += 1;
    if (rawKind === 'session') usage.currentSession = entry;
    else if (modelName && modelName.toLowerCase() === 'all models') usage.currentWeek = entry;
    else if (modelName) usage.modelWeeks[modelName] = entry;
  }

  if (usage.linesParsed === 0) return null;
  return usage;
}

export function formatQuotaUsage(usage = null) {
  if (!usage) return null;
  return {
    session: usage.currentSession ? {
      usedPercent: usage.currentSession.percentUsed,
      resetAt: isoOrNull(usage.currentSession.resetAt),
      resetText: usage.currentSession.resetText || null,
    } : null,
    week: usage.currentWeek ? {
      usedPercent: usage.currentWeek.percentUsed,
      resetAt: isoOrNull(usage.currentWeek.resetAt),
      resetText: usage.currentWeek.resetText || null,
    } : null,
    models: Object.fromEntries(Object.entries(usage.modelWeeks || {}).map(([model, entry]) => [model, {
      usedPercent: entry.percentUsed,
      resetAt: isoOrNull(entry.resetAt),
      resetText: entry.resetText || null,
    }])),
    linesParsed: usage.linesParsed || 0,
  };
}

/**
 * Parse a precise reset time out of Claude CLI output. Returns null (fail
 * closed / "no precise time known") whenever the text has no timestamp or the
 * timestamp is implausible, so callers fall back to the minimum backoff.
 */
export function parseQuotaResetTime(text = '', { now = new Date() } = {}) {
  const value = String(text || '');
  for (const pattern of RESET_TIME_PATTERNS) {
    const match = value.match(pattern);
    if (!match) continue;
    const parsed = plausibleResetOrNull(new Date(match[1]), { now });
    if (parsed) return parsed;
  }
  const usage = parseClaudeUsageOutput(value, { now });
  return usage?.currentSession?.resetAt || usage?.currentWeek?.resetAt || null;
}

/**
 * Conservative backoff: at least MIN_QUOTA_BACKOFF_MS, unless a precise reset
 * time is known and it is later than that minimum.
 */
export function computeQuotaBackoffMs({ resetAt = null, now = new Date(), minDelayMs = MIN_QUOTA_BACKOFF_MS } = {}) {
  if (resetAt instanceof Date && !Number.isNaN(resetAt.getTime())) {
    const untilReset = resetAt.getTime() - now.getTime();
    if (untilReset > minDelayMs) return untilReset;
  }
  return minDelayMs;
}

export function recordQuotaPause({ reason, matchedPattern = null, resetAt = null, now = new Date(), minDelayMs = MIN_QUOTA_BACKOFF_MS } = {}) {
  const delayMs = computeQuotaBackoffMs({ resetAt, now, minDelayMs });
  const pausedUntil = new Date(now.getTime() + delayMs);
  return {
    reason,
    matchedPattern,
    detectedAt: now.toISOString(),
    resetAt: resetAt ? resetAt.toISOString() : null,
    pausedUntil: pausedUntil.toISOString(),
    minDelayMs,
  };
}

/**
 * Evaluate a persisted pause-state object against the current time.
 * Corrupt/unparseable state is treated as "not paused" (nothing to enforce)
 * rather than blocked forever — that is a data-hygiene fallback, distinct
 * from the fail-closed behaviour applied to live quota-signal parsing above.
 */
export function evaluateQuotaPauseState(state, { now = new Date() } = {}) {
  if (!state || !state.pausedUntil) return { paused: false };
  const pausedUntil = new Date(state.pausedUntil);
  if (Number.isNaN(pausedUntil.getTime())) return { paused: false, invalidState: true };
  if (now.getTime() >= pausedUntil.getTime()) return { paused: false, dueForRecheck: true, pausedUntil };
  return { paused: true, pausedUntil, reason: state.reason || 'quota-exhausted', resetAt: state.resetAt || null };
}

/**
 * Parse the output of a dedicated quota-check invocation (e.g. `claude -p
 * '/usage'`). Ambiguous output (neither a clear exhaustion nor a clear
 * availability signal) fails closed to 'ambiguous' so callers keep the pause
 * in place rather than assuming quota is free.
 */
export function parseQuotaCheckOutput(text = '', { now = new Date(), maxSessionUsageBeforeStartPercent = DEFAULT_MAX_SESSION_USAGE_BEFORE_START_PERCENT } = {}) {
  const value = String(text || '');

  // Older runner builds used `/quota`, which current Claude Code CLI reports
  // as unsupported. Treat that exact legacy error as non-blocking so a stale
  // local check cannot keep the runner paused forever.
  if (LEGACY_QUOTA_UNSUPPORTED_PATTERN.test(value)) {
    return { status: 'available', resetAt: null, matchedPattern: 'unsupported-legacy-quota-command', quotaUsage: null };
  }

  const usageOutput = parseClaudeUsageOutput(value, { now });
  if (usageOutput?.currentSession) {
    const threshold = normalizeStartThreshold(maxSessionUsageBeforeStartPercent);
    const { percentUsed, resetAt } = usageOutput.currentSession;
    const base = {
      resetAt,
      percentUsed,
      sessionPercentUsed: percentUsed,
      weeklyPercentUsed: usageOutput.currentWeek?.percentUsed ?? null,
      weeklyResetAt: usageOutput.currentWeek?.resetAt ?? null,
      modelWeekPercentUsed: Object.fromEntries(Object.entries(usageOutput.modelWeeks).map(([model, entry]) => [model, entry.percentUsed])),
      usage: usageOutput,
      quotaUsage: formatQuotaUsage(usageOutput),
      maxSessionUsageBeforeStartPercent: threshold,
    };

    if (percentUsed >= 100) {
      return {
        ...base,
        status: 'exhausted',
        matchedPattern: 'claude-usage-current-session-100-percent',
      };
    }
    if (percentUsed >= threshold) {
      return {
        ...base,
        status: 'exhausted',
        matchedPattern: 'claude-usage-current-session-above-start-threshold',
      };
    }
    return {
      ...base,
      status: 'available',
      matchedPattern: 'claude-usage-current-session',
    };
  }

  const exhaustion = detectQuotaExhaustion(value);
  if (exhaustion.exhausted) {
    return { status: 'exhausted', resetAt: parseQuotaResetTime(value, { now }), matchedPattern: exhaustion.matchedPattern, quotaUsage: null };
  }
  if (QUOTA_AVAILABLE_PATTERNS.some((pattern) => pattern.test(value))) {
    return { status: 'available', resetAt: null, matchedPattern: null, quotaUsage: null };
  }
  return { status: 'ambiguous', resetAt: null, matchedPattern: null, quotaUsage: null };
}

export function buildQuotaCheckArgs({ permissionMode = 'plan' } = {}) {
  return ['-p', '--output-format', 'text', '--permission-mode', permissionMode, '/usage'];
}
