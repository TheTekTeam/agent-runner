// Shared secret redaction for ops tooling output: run plans, prompts, logs,
// summaries, and anything else that might be written to disk or a GitHub
// comment. Over-redaction (false positives on non-secret text) is acceptable;
// under-redaction is not.

const REPLACERS = [
  // Provider / vendor tokens with recognisable prefixes.
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED_ANTHROPIC_KEY]'],
  [/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_API_KEY]'],
  [/sk_(?:live|test)_[A-Za-z0-9]{10,}/gi, '[REDACTED_API_KEY]'],
  [/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED_GOOGLE_KEY]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY_ID]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]'],
  [/glpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED_GITLAB_TOKEN]'],

  // Bearer/authorization headers.
  [/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]'],
  [/Authorization:\s*.+/gi, 'Authorization: [REDACTED]'],

  // key=value / key: value secret-shaped assignments (query strings, .env-ish inline text).
  [/\b(api[_-]?key|token|secret|password|passwd|client[_-]?secret|private[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|auth[_-]?token|bearer[_-]?token)\s*[:=]\s*[^\s&"'#]+/gi, '$1=[REDACTED]'],

  // Full .env-style lines whose key name looks sensitive.
  [/^([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)\s*=\s*.+$/gim, '$1=[REDACTED]'],

  // Database / broker connection URLs.
  [/(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'#]+/gi, '$1://[REDACTED]'],

  // Cookies.
  [/^Set-Cookie:.*$/gim, 'Set-Cookie: [REDACTED]'],
  [/^Cookie:.*$/gim, 'Cookie: [REDACTED]'],

  // Playwright-style storage-state JSON: {"name":"...","value":"..."} pairs
  // used for cookies and localStorage entries.
  [/"name"\s*:\s*"[^"]*"\s*,\s*"value"\s*:\s*"[^"]*"/gi, (match) => match.replace(/"value"\s*:\s*"[^"]*"/i, '"value":"[REDACTED]"')],
];

export function redactSensitiveText(text) {
  let value = String(text ?? '');
  for (const [pattern, replacement] of REPLACERS) {
    value = value.replace(pattern, replacement);
  }
  return value;
}

// Flags whose immediately-following CLI argument is a restricted resume
// session reference (#698 finding 2 re-review). Generic text-pattern
// redaction above cannot catch this: a session id has no recognisable
// shape, so it must be redacted positionally — by exact argument index
// relative to the flag, not by content matching.
const SESSION_VALUE_FLAGS = new Set(['--resume', '--resume-session']);
const REDACTED_SESSION_PLACEHOLDER = '[REDACTED_SESSION]';
const REDACTED_PROMPT_PLACEHOLDER = '<prompt omitted>';

/**
 * Build a safe-to-log preview of an executable argument list (never the
 * list actually passed to spawn). The value immediately following
 * `--resume` or `--resume-session` is replaced wherever it appears in the
 * array, not only assuming a fixed position. When `redactFinalAsPrompt` is
 * set, the last argument (the Claude prompt) is also replaced — matching
 * the two independent things a runner invocation must never leak.
 */
export function redactExecutableArgs(args = [], { redactFinalAsPrompt = false } = {}) {
  const list = Array.isArray(args) ? args : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    if (redactFinalAsPrompt && i === list.length - 1) {
      out.push(REDACTED_PROMPT_PLACEHOLDER);
      continue;
    }
    const value = list[i];
    out.push(value);
    if (SESSION_VALUE_FLAGS.has(String(value)) && i + 1 < list.length) {
      i += 1;
      out.push(REDACTED_SESSION_PLACEHOLDER);
    }
  }
  return out;
}

export function redactSensitiveJson(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveJson(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactSensitiveJson(item);
    }
    return out;
  }
  return value;
}
