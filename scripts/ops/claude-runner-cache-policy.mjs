const CACHE_DISABLE_VARIABLES = Object.freeze({
  global: 'DISABLE_PROMPT_CACHING',
  haiku: 'DISABLE_PROMPT_CACHING_HAIKU',
  sonnet: 'DISABLE_PROMPT_CACHING_SONNET',
  opus: 'DISABLE_PROMPT_CACHING_OPUS',
});

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function claudeModelFamily(model = '') {
  const value = String(model || '').trim().toLowerCase();
  if (value.includes('haiku')) return 'haiku';
  if (value.includes('sonnet')) return 'sonnet';
  if (value.includes('opus')) return 'opus';
  return null;
}

/**
 * Inspect only Anthropic's documented prompt-cache disable controls. The
 * result is deliberately bounded: it exposes the matching variable name but
 * never its value or any unrelated environment content.
 */
export function inspectClaudePromptCachePolicy({ model, env = process.env } = {}) {
  const modelFamily = claudeModelFamily(model);
  const globalVariable = CACHE_DISABLE_VARIABLES.global;
  const modelVariable = modelFamily ? CACHE_DISABLE_VARIABLES[modelFamily] : null;
  const disableVariable = truthy(env?.[globalVariable])
    ? globalVariable
    : (modelVariable && truthy(env?.[modelVariable]) ? modelVariable : null);

  return {
    enabled: disableVariable === null,
    state: disableVariable === null ? 'enabled' : 'disabled',
    reason: disableVariable === null
      ? null
      : (disableVariable === globalVariable ? 'global-disable' : 'model-disable'),
    modelFamily,
    disableVariable,
  };
}

export function assertClaudePromptCacheEnabled({ model, env = process.env, allowDisabled = false } = {}) {
  const policy = inspectClaudePromptCachePolicy({ model, env });
  if (!policy.enabled && !allowDisabled) {
    const error = new Error(`Claude prompt caching is disabled by ${policy.disableVariable}; refusing to launch cache-disabled execution.`);
    error.code = 'claude-prompt-cache-disabled';
    error.cachePolicy = policy;
    throw error;
  }
  return policy;
}

export const CLAUDE_PROMPT_CACHE_DISABLE_VARIABLES = Object.freeze(Object.values(CACHE_DISABLE_VARIABLES));
