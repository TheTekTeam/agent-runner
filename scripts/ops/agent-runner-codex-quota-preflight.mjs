import { spawn, spawnSync } from 'node:child_process';

const STRIPPED_ENV_KEYS = Object.freeze([
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_BASE_URL',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
]);

export function sanitizeCodexEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of STRIPPED_ENV_KEYS) delete clean[key];
  clean.GIT_TERMINAL_PROMPT = '0';
  return clean;
}

export function classifyCodexLoginStatus(text = '', exitCode = null) {
  const value = String(text || '');
  if (exitCode !== 0) return Object.freeze({ authenticated: false, mode: 'unknown', reason: 'codex-auth-status-failed' });
  if (value.includes('Logged in using ChatGPT')) return Object.freeze({ authenticated: true, mode: 'chatgpt', reason: null });
  if (/Not logged in/i.test(value)) return Object.freeze({ authenticated: false, mode: 'none', reason: 'codex-not-logged-in' });
  if (/Logged in using an API key/i.test(value)) return Object.freeze({ authenticated: false, mode: 'api-key', reason: 'codex-api-key-route-forbidden' });
  if (/Logged in using access token/i.test(value)) return Object.freeze({ authenticated: false, mode: 'access-token', reason: 'codex-token-route-forbidden' });
  if (/Logged in using personal access token/i.test(value)) return Object.freeze({ authenticated: false, mode: 'personal-access-token', reason: 'codex-token-route-forbidden' });
  return Object.freeze({ authenticated: false, mode: 'unknown', reason: 'codex-auth-posture-unknown' });
}

export function probeCodexLogin({
  executablePath = 'codex',
  env = process.env,
  spawnSyncFn = spawnSync,
} = {}) {
  const result = spawnSyncFn(executablePath, ['login', 'status'], {
    env: sanitizeCodexEnvironment(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitCode = Number.isInteger(result?.status) ? result.status : null;
  return classifyCodexLoginStatus(`${result?.stdout || ''}\n${result?.stderr || ''}`, exitCode);
}

function validPercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const usedPercent = validPercent(window.usedPercent ?? window.used_percent);
  if (usedPercent === null) return null;
  const resetsAtRaw = window.resetsAt ?? window.resets_at;
  const resetsAt = Number.isFinite(Number(resetsAtRaw)) ? Number(resetsAtRaw) : null;
  const durationRaw = window.windowDurationMins ?? window.window_duration_mins;
  const windowMinutes = Number.isFinite(Number(durationRaw)) ? Number(durationRaw) : null;
  return Object.freeze({
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetsAt,
    windowMinutes,
  });
}

export function evaluateCodexRateLimits(payload, { maxUsedPercent = 90 } = {}) {
  const result = payload?.result && typeof payload.result === 'object' ? payload.result : payload;
  const limits = result?.rateLimits ?? result?.rate_limits;
  if (!limits || typeof limits !== 'object') {
    return Object.freeze({ blocked: true, reason: 'codex-quota-evidence-unavailable', primary: null, secondary: null });
  }

  const primary = normalizeWindow(limits.primary);
  const secondary = normalizeWindow(limits.secondary);
  if (!primary || !secondary) {
    return Object.freeze({ blocked: true, reason: 'codex-quota-evidence-ambiguous', primary, secondary });
  }

  const reached = limits.rateLimitReachedType ?? limits.rate_limit_reached_type;
  if (reached !== undefined && reached !== null && String(reached).toLowerCase() !== 'none') {
    return Object.freeze({ blocked: true, reason: 'codex-quota-blocked', primary, secondary });
  }

  const threshold = Number(maxUsedPercent);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    return Object.freeze({ blocked: true, reason: 'codex-quota-threshold-invalid', primary, secondary });
  }

  if (primary.usedPercent > threshold || secondary.usedPercent > threshold) {
    return Object.freeze({ blocked: true, reason: 'codex-quota-threshold-exceeded', primary, secondary });
  }

  return Object.freeze({
    blocked: false,
    reason: null,
    primary,
    secondary,
    planType: typeof (limits.planType ?? limits.plan_type) === 'string'
      ? (limits.planType ?? limits.plan_type)
      : null,
  });
}

export function readCodexRateLimits({
  executablePath = 'codex',
  env = process.env,
  spawnFn = spawn,
  timeoutMs = 25_000,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let initialized = false;
    let buffer = '';

    const child = spawnFn(executablePath, ['app-server'], {
      env: sanitizeCodexEnvironment(env),
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'codex-quota-probe-timeout', response: null }), timeoutMs);

    child.on('error', () => finish({ ok: false, reason: 'codex-app-server-unavailable', response: null }));
    child.on('exit', () => {
      if (!settled) finish({ ok: false, reason: 'codex-app-server-exited', response: null });
    });

    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;

        let message;
        try { message = JSON.parse(line); } catch { continue; }

        if (message.id === 1 && !initialized) {
          if (message.error) return finish({ ok: false, reason: 'codex-app-server-initialize-failed', response: null });
          initialized = true;
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null })}\n`);
          continue;
        }

        if (message.id === 2) {
          if (message.error) return finish({ ok: false, reason: 'codex-quota-rpc-failed', response: null });
          return finish({ ok: true, reason: null, response: message });
        }
      }
    });

    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agent_runner_codex_preflight', title: 'Agent Runner Codex Preflight', version: '1.0.0' },
        capabilities: null,
      },
    })}\n`);
  });
}

export async function runCodexQuotaPreflight({
  executablePath = 'codex',
  env = process.env,
  maxUsedPercent = 90,
  spawnSyncFn = spawnSync,
  spawnFn = spawn,
} = {}) {
  const auth = probeCodexLogin({ executablePath, env, spawnSyncFn });
  if (!auth.authenticated || auth.mode !== 'chatgpt') {
    return Object.freeze({
      allowed: false,
      reason: auth.reason || 'codex-auth-failed',
      authMode: auth.mode,
      resourceState: Object.freeze({ blocked: true, reason: auth.reason || 'codex-auth-failed' }),
    });
  }

  const quota = await readCodexRateLimits({ executablePath, env, spawnFn });
  if (!quota.ok) {
    return Object.freeze({
      allowed: false,
      reason: quota.reason,
      authMode: auth.mode,
      resourceState: Object.freeze({ blocked: true, reason: quota.reason }),
    });
  }

  const resourceState = evaluateCodexRateLimits(quota.response, { maxUsedPercent });
  return Object.freeze({
    allowed: resourceState.blocked === false,
    reason: resourceState.reason,
    authMode: auth.mode,
    resourceState,
  });
}
