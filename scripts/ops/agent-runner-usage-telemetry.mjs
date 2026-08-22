/**
 * #194 provider-neutral, positive-allowlisted usage/cache efficiency contract.
 *
 * This module is deliberately pure. It never reads prompts, provider output,
 * credentials, session handles, paths, environment state, pricing or billing
 * data. Callers must pass only already-structured bounded fields. Unknown
 * provider evidence remains null; a genuine reported zero remains zero.
 */

export const USAGE_EFFICIENCY_SCHEMA_VERSION = 'agent-runner-usage-efficiency/v1';

export const CACHE_STRATEGIES = Object.freeze([
  'provider-managed',
  'automatic-prefix',
  'explicit-prefix',
  'local-context',
  'none',
  'unknown',
]);

export const TELEMETRY_AVAILABILITY = Object.freeze([
  'available',
  'partial',
  'unavailable',
]);

export const COST_POSTURES = Object.freeze([
  'included-subscription',
  'free-local',
  'separately-metered',
  'unknown',
]);

const MAX_TOKEN_COUNT = 10 ** 12;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REASON_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

function boundedId(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  return ID_PATTERN.test(text) ? text : null;
}

function boundedReason(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  return text.length <= 120 && REASON_PATTERN.test(text) ? text : null;
}

function boundedNumber(value, { integer = false, max = MAX_TOKEN_COUNT } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) return null;
  if (integer && !Number.isInteger(number)) return null;
  return number;
}

function tokenCount(value) {
  return boundedNumber(value, { integer: true, max: MAX_TOKEN_COUNT });
}

function durationMs(value) {
  return boundedNumber(value, { integer: false, max: MAX_DURATION_MS });
}

function ratio(numerator, denominator) {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

function rate(tokens, duration) {
  if (tokens === null || duration === null || duration <= 0) return null;
  return tokens / (duration / 1000);
}

function normalizedStrategy(value) {
  return CACHE_STRATEGIES.includes(value) ? value : 'unknown';
}

function normalizedCostPosture(value) {
  return COST_POSTURES.includes(value) ? value : 'unknown';
}

function stableFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value) ? value : null;
}

function ttlCacheCreation(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { fiveMinute: null, oneHour: null };
  }
  return {
    fiveMinute: tokenCount(
      value.ephemeral_5m_input_tokens
      ?? value.fiveMinute
      ?? value.five_minute
      ?? value.cache_creation_5m_input_tokens
      ?? value.cacheCreation5mInputTokens,
    ),
    oneHour: tokenCount(
      value.ephemeral_1h_input_tokens
      ?? value.oneHour
      ?? value.one_hour
      ?? value.cache_creation_1h_input_tokens
      ?? value.cacheCreation1hInputTokens,
    ),
  };
}

/**
 * Normalize one adapter/provider usage record. The function accepts common
 * structured snake_case/camelCase aliases solely to make bounded provider
 * adapters simple; every returned key is a fixed allowlisted field.
 */
export function normalizeUsageEfficiencyEnvelope(value = {}, defaults = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const ttl = ttlCacheCreation(
    source.cacheCreationByTtl
    ?? source.cache_creation
    ?? source.cache_creation_by_ttl
    ?? source,
  );

  const rawInputTokens = tokenCount(source.inputTokens ?? source.input_tokens);
  const cacheReadTokens = tokenCount(
    source.cacheReadTokens
    ?? source.cacheReadInputTokens
    ?? source.cache_read_input_tokens
    ?? source.cached_tokens,
  );
  const cacheCreationTokens = tokenCount(
    source.cacheCreationTokens
    ?? source.cacheCreationInputTokens
    ?? source.cache_creation_input_tokens
    ?? source.cache_write_tokens,
  );
  const outputTokens = tokenCount(source.outputTokens ?? source.output_tokens);
  const reasoningTokens = tokenCount(
    source.reasoningTokens
    ?? source.reasoning_tokens
    ?? source.output_tokens_details?.reasoning_tokens,
  );
  const promptEvalTokens = tokenCount(
    source.promptEvalTokens
    ?? source.prompt_eval_count
    ?? source.prompt_eval_tokens,
  );

  let inputTokens = tokenCount(source.totalInputTokens ?? source.total_input_tokens);
  let uncachedInputTokens = tokenCount(source.uncachedInputTokens ?? source.uncached_input_tokens);
  if (inputTokens === null) inputTokens = rawInputTokens;
  if (uncachedInputTokens === null && source.inputSemantics === 'claude-partitioned') {
    uncachedInputTokens = rawInputTokens;
    if (rawInputTokens !== null && cacheReadTokens !== null && cacheCreationTokens !== null) {
      const total = rawInputTokens + cacheReadTokens + cacheCreationTokens;
      inputTokens = total <= MAX_TOKEN_COUNT ? total : null;
    }
  } else if (uncachedInputTokens === null && source.inputSemantics === 'cached-subset') {
    if (rawInputTokens !== null && cacheReadTokens !== null && cacheReadTokens <= rawInputTokens) {
      uncachedInputTokens = rawInputTokens - cacheReadTokens;
    }
  }

  const promptEvalDurationMs = durationMs(
    source.promptEvalDurationMs
    ?? source.prompt_eval_duration_ms
    ?? (Number.isFinite(source.prompt_eval_duration) ? source.prompt_eval_duration / 1_000_000 : null),
  );
  const modelLoadDurationMs = durationMs(
    source.modelLoadDurationMs
    ?? source.model_load_duration_ms
    ?? (Number.isFinite(source.load_duration) ? source.load_duration / 1_000_000 : null),
  );
  const totalDurationMs = durationMs(
    source.totalDurationMs
    ?? source.total_duration_ms
    ?? (Number.isFinite(source.total_duration) ? source.total_duration / 1_000_000 : null),
  );

  const costPosture = normalizedCostPosture(source.costPosture ?? defaults.costPosture);
  const paid = costPosture === 'separately-metered'
    ? source.paid === true
    : false;
  const costUsd = costPosture === 'free-local'
    ? 0
    : costPosture === 'separately-metered'
      ? boundedNumber(source.costUsd ?? source.cost_usd, { max: 10 ** 9 })
      : null;

  const numericEvidence = [
    inputTokens, outputTokens, reasoningTokens, cacheReadTokens,
    cacheCreationTokens, ttl.fiveMinute, ttl.oneHour, uncachedInputTokens,
    promptEvalTokens, promptEvalDurationMs, modelLoadDurationMs, totalDurationMs,
  ];
  const explicitAvailability = TELEMETRY_AVAILABILITY.includes(source.telemetryAvailability)
    ? source.telemetryAvailability
    : null;
  const telemetryAvailability = explicitAvailability
    ?? (numericEvidence.some((entry) => entry !== null) ? 'partial' : 'unavailable');

  const cacheReadShare = ratio(cacheReadTokens, inputTokens);
  const cacheWriteShare = ratio(cacheCreationTokens, inputTokens);
  const promptEvalTokensPerSecond = rate(promptEvalTokens, promptEvalDurationMs);
  const outputTokensPerSecond = rate(outputTokens, totalDurationMs);

  return Object.freeze({
    schemaVersion: USAGE_EFFICIENCY_SCHEMA_VERSION,
    provider: boundedId(source.provider ?? defaults.provider),
    adapter: boundedId(source.adapter ?? defaults.adapter),
    model: boundedId(source.model ?? defaults.model),
    costPosture,
    paid,
    costUsd,
    inputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheCreation5mTokens: ttl.fiveMinute,
    cacheCreation1hTokens: ttl.oneHour,
    promptEvalTokens,
    promptEvalDurationMs,
    modelLoadDurationMs,
    totalDurationMs,
    cacheStrategy: normalizedStrategy(source.cacheStrategy ?? defaults.cacheStrategy),
    telemetryAvailability,
    availabilityReason: boundedReason(source.availabilityReason ?? defaults.availabilityReason),
    stablePrefixFingerprint: stableFingerprint(
      source.stablePrefixFingerprint
      ?? defaults.stablePrefixFingerprint,
    ),
    cacheReadShare,
    cacheWriteShare,
    promptEvalTokensPerSecond,
    outputTokensPerSecond,
  });
}

/** Claude Code's structured result partitions uncached/cache-read/cache-write input. */
export function normalizeClaudeUsageEfficiency({ usage = null, model = null, promptCacheMetadata = null, totalDurationMs = null } = {}) {
  const record = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
  return normalizeUsageEfficiencyEnvelope({
    ...record,
    inputSemantics: 'claude-partitioned',
    totalDurationMs,
    costPosture: 'included-subscription',
    paid: false,
  }, {
    provider: 'claude-code',
    adapter: 'claude-code-cli',
    model,
    cacheStrategy: promptCacheMetadata?.cacheStrategy || 'provider-managed',
    stablePrefixFingerprint: promptCacheMetadata?.stablePrefixFingerprint || null,
    availabilityReason: usage ? null : 'structured-usage-unavailable',
  });
}

/** OpenAI/Codex cached tokens, when present, are a subset of reported input. */
export function normalizeCodexUsageEfficiency({ usage = null, model = null } = {}) {
  const record = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
  return normalizeUsageEfficiencyEnvelope({
    ...record,
    inputSemantics: 'cached-subset',
    costPosture: 'included-subscription',
    paid: false,
  }, {
    provider: 'codex-cli',
    adapter: 'codex-cli',
    model,
    cacheStrategy: 'provider-managed',
    availabilityReason: usage ? null : 'structured-usage-unavailable',
  });
}

/** Ollama duration fields are official nanosecond counters in structured output. */
export function normalizeOllamaUsageEfficiency({ usage = null, model = null } = {}) {
  const record = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
  return normalizeUsageEfficiencyEnvelope({
    ...record,
    outputTokens: record.outputTokens ?? record.output_tokens ?? record.eval_count ?? record.eval_tokens,
    costPosture: 'free-local',
    paid: false,
  }, {
    provider: 'ollama-local',
    adapter: 'ollama-agent',
    model,
    cacheStrategy: 'local-context',
    availabilityReason: usage ? null : 'structured-usage-unavailable',
  });
}

/**
 * Allowlist Claude's structured usage object before it enters ordinary run
 * state. This is the #194 extension of the runner's existing sanitizer: the
 * only newly retained structure is the numeric cache-creation TTL breakdown.
 */
export function sanitizeClaudeStructuredUsage(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ttl = ttlCacheCreation(value.cacheCreationByTtl ?? value.cache_creation ?? value.cache_creation_by_ttl);
  const hasTtl = ttl.fiveMinute !== null || ttl.oneHour !== null;
  const normalized = {
    inputTokens: tokenCount(value.inputTokens ?? value.input_tokens),
    outputTokens: tokenCount(value.outputTokens ?? value.output_tokens),
    cacheReadInputTokens: tokenCount(value.cacheReadInputTokens ?? value.cache_read_input_tokens),
    cacheCreationInputTokens: tokenCount(value.cacheCreationInputTokens ?? value.cache_creation_input_tokens),
    ...(hasTtl ? {
      cacheCreationByTtl: {
        ephemeral_5m_input_tokens: ttl.fiveMinute,
        ephemeral_1h_input_tokens: ttl.oneHour,
      },
    } : {}),
  };
  return Object.values(normalized).some((entry) => entry !== null) ? normalized : null;
}

/**
 * Allowlist Claude's per-model accounting without retaining arbitrary nested
 * provider/session fields. Model ids and every retained metric are bounded.
 */
export function sanitizeClaudeModelUsage(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([model, modelRecord]) => {
    const modelId = boundedId(model);
    if (!modelId || !modelRecord || typeof modelRecord !== 'object' || Array.isArray(modelRecord)) return [];
    const tokens = sanitizeClaudeStructuredUsage(modelRecord);
    const normalized = {
      ...(tokens || {}),
      costUsd: boundedNumber(modelRecord.costUsd ?? modelRecord.costUSD ?? modelRecord.cost_usd, { max: 10 ** 9 }),
      contextWindow: tokenCount(modelRecord.contextWindow ?? modelRecord.context_window),
      maxOutputTokens: tokenCount(modelRecord.maxOutputTokens ?? modelRecord.max_output_tokens),
    };
    if (!Object.values(normalized).some((entry) => entry !== null)) return [];
    return [[modelId, normalized]];
  }));
}

function elapsedDurationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
  return durationMs(finished - started);
}

/**
 * Build Claude's existing accounting shape plus the #194 adapter-neutral
 * efficiency projection. The helper sanitizes its own nested structured input
 * so callers cannot bypass the telemetry boundary by supplying a richer raw
 * result envelope than the production parser normally returns.
 */
export function buildClaudeUsageAccounting({
  resultEnvelope = null,
  model = null,
  promptCacheMetadata = null,
  startedAt = null,
  finishedAt = null,
} = {}) {
  const envelope = resultEnvelope && typeof resultEnvelope === 'object' && !Array.isArray(resultEnvelope)
    ? resultEnvelope
    : {};
  const usage = sanitizeClaudeStructuredUsage(envelope.usage);
  const modelUsage = sanitizeClaudeModelUsage(envelope.modelUsage ?? envelope.model_usage);
  const runDurationMs = elapsedDurationMs(startedAt, finishedAt);

  return {
    source: envelope.parsed ? 'claude-cli-result-envelope' : 'unavailable',
    accountingAvailable: envelope.accountingAvailable === true,
    subtype: typeof envelope.subtype === 'string' ? envelope.subtype.slice(0, 120) : null,
    isError: envelope.isError === true,
    numTurns: boundedNumber(envelope.numTurns),
    totalCostUsd: boundedNumber(envelope.totalCostUsd, { max: 10 ** 9 }),
    usage,
    modelUsage,
    sessionIdPresentButNotStored: envelope.hasSessionId === true,
    efficiency: normalizeClaudeUsageEfficiency({
      usage,
      model,
      promptCacheMetadata,
      totalDurationMs: runDurationMs,
    }),
  };
}
