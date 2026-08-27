// Bounded shell policy for the OpenCode/Ollama coding worker (#378).
//
// This is deliberately stricter than a normal interactive development shell.
// Commands are exact strings selected from:
//   1. a tiny fixed read-only Git set;
//   2. one or more manager-approved validation commands that also satisfy
//      the safe command grammar; and
//   3. for broader project toolchains, the intersection of manager approval
//      and a machine-local exact-command allowlist.
//
// No shell metacharacters, substitutions, redirections or arbitrary command
// prefixes are accepted. OpenCode's permission.bash rules are an additional
// enforcement layer; callers must still validate commands here.

const SAFE_TOKEN = /^[A-Za-z0-9._/@:+,=~-]+$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const FORBIDDEN_SHELL_SYNTAX = /[\0\r\n;&|><`$(){}\\'"]/;

export const FIXED_OLLAMA_SHELL_COMMANDS = Object.freeze([
  'git status --porcelain=v1',
  'git diff --no-ext-diff',
  'git diff --no-ext-diff --check',
  'git diff --no-ext-diff --stat',
]);

export function isSafeRelativeShellPath(value) {
  const path = String(value || '').trim();
  if (!path || path.length > 240 || !SAFE_PATH.test(path)) return false;
  return !path.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.'));
}

export function tokenizeBoundedShellCommand(command) {
  const text = String(command || '').trim();
  if (!text || text.length > 500 || FORBIDDEN_SHELL_SYNTAX.test(text)) {
    return { ok: false, reason: 'ollama-shell-syntax-denied', argv: [] };
  }
  const argv = text.split(/\s+/);
  if (argv.some((token) => !SAFE_TOKEN.test(token))) {
    return { ok: false, reason: 'ollama-shell-token-denied', argv: [] };
  }
  return { ok: true, reason: null, argv };
}

function exactAllowlist(values = []) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isShellTrustedRepository(repository, trustedRepositories = []) {
  const repo = String(repository || '').trim();
  if (!REPOSITORY.test(repo)) return false;
  const normalized = new Set((Array.isArray(trustedRepositories) ? trustedRepositories : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => REPOSITORY.test(value)));
  return normalized.has(repo.toLowerCase());
}

export function classifyBoundedOllamaShellCommand(command, {
  repository = null,
  trustedRepositories = [],
  managerValidationCommands = [],
  machineCommandAllowlist = [],
} = {}) {
  const parsed = tokenizeBoundedShellCommand(command);
  if (!parsed.ok) return { ...parsed, allowed: false, kind: null };
  if (!isShellTrustedRepository(repository, trustedRepositories)) {
    return { allowed: false, reason: 'ollama-shell-repository-not-trusted', kind: null, argv: [] };
  }

  const text = parsed.argv.join(' ');
  if (FIXED_OLLAMA_SHELL_COMMANDS.includes(text)) {
    return { allowed: true, reason: null, kind: 'fixed-readonly-git', argv: parsed.argv, command: text };
  }

  const manager = exactAllowlist(managerValidationCommands);
  if (!manager.has(text)) {
    return { allowed: false, reason: 'ollama-shell-command-not-manager-approved', kind: null, argv: [] };
  }

  // Built-in narrow validation family: exact manager authority is sufficient,
  // but the test target must be one safe repository-relative path.
  if (parsed.argv.length === 3
    && parsed.argv[0] === 'node'
    && parsed.argv[1] === '--test'
    && isSafeRelativeShellPath(parsed.argv[2])) {
    return { allowed: true, reason: null, kind: 'focused-node-test', argv: parsed.argv, command: text };
  }

  // Everything broader (pnpm/npm/tsx/vitest/tsc/etc.) requires BOTH the
  // manager packet and machine-local exact-command allowlist to name the
  // identical command. No prefix/wildcard interpretation is permitted here.
  const machine = exactAllowlist(machineCommandAllowlist);
  if (!machine.has(text)) {
    return { allowed: false, reason: 'ollama-shell-command-not-machine-allowlisted', kind: null, argv: [] };
  }

  return { allowed: true, reason: null, kind: 'machine-qualified-validation', argv: parsed.argv, command: text };
}

export function buildBoundedOpenCodeBashPermission({
  repository = null,
  trustedRepositories = [],
  managerValidationCommands = [],
  machineCommandAllowlist = [],
} = {}) {
  const candidates = [
    ...FIXED_OLLAMA_SHELL_COMMANDS,
    ...(Array.isArray(managerValidationCommands) ? managerValidationCommands : []),
  ];
  const accepted = [];
  for (const command of candidates) {
    const decision = classifyBoundedOllamaShellCommand(command, {
      repository,
      trustedRepositories,
      managerValidationCommands,
      machineCommandAllowlist,
    });
    if (decision.allowed && !accepted.includes(decision.command)) accepted.push(decision.command);
  }

  // V1 OpenCode permission semantics: last matching rule wins. Keep the
  // catch-all deny first, then exact accepted commands only.
  return Object.freeze({
    '*': 'deny',
    ...Object.fromEntries(accepted.map((command) => [command, 'allow'])),
  });
}

export function buildBoundedOllamaToolPermission({
  filePath,
  repository = null,
  trustedRepositories = [],
  managerValidationCommands = [],
  machineCommandAllowlist = [],
} = {}) {
  if (!isSafeRelativeShellPath(filePath)) throw new Error('invalid bounded Ollama file path');
  return Object.freeze({
    '*': 'deny',
    read: Object.freeze({ '*': 'deny', [filePath]: 'allow' }),
    edit: Object.freeze({ '*': 'deny', [filePath]: 'allow' }),
    bash: buildBoundedOpenCodeBashPermission({
      repository,
      trustedRepositories,
      managerValidationCommands,
      machineCommandAllowlist,
    }),
    external_directory: Object.freeze({ '*': 'deny' }),
  });
}
