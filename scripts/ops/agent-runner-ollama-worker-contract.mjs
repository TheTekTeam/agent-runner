// Strict live-executor contract for the positively qualified #152 Ollama coding profile.
//
// Manager scope/validation text is not arbitrary filesystem or command authority.
// The initial live profile deliberately accepts one bounded repository-relative
// file and one bounded task. Shell authority comes only from #378's deterministic
// policy, which independently intersects manager validation with machine-local
// trusted-repository / command allowlists.
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_TASK_CHARS = 1000;

function yamlBlocks(body = '') {
  return [...String(body || '').matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)].map((match) => match[1]);
}

function yamlList(body, key) {
  for (const block of yamlBlocks(body)) {
    const lines = block.split(/\r?\n/);
    let found = false;
    let active = false;
    const values = [];
    for (const line of lines) {
      const top = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
      if (top) {
        active = top[1] === key;
        if (active) found = true;
        continue;
      }
      if (!active) continue;
      const item = line.match(/^\s+-\s+(.*\S)\s*$/)?.[1];
      if (item !== undefined) values.push(item.trim().replace(/^["']|["']$/g, ''));
    }
    if (found) return values;
  }
  return [];
}

export function isSafeOllamaWorkerPath(value) {
  const path = String(value || '').trim();
  if (!path || path.length > 240 || !SAFE_RELATIVE_PATH.test(path)) return false;
  const parts = path.split('/');
  if (parts.some((part) => part === '.' || part === '..' || part.startsWith('.'))) return false;
  return true;
}

export function resolveBoundedOllamaManagerContract(commentOrBody) {
  const body = typeof commentOrBody === 'string'
    ? commentOrBody
    : String(commentOrBody?.body || '');
  const scope = yamlList(body, 'scope');
  const validationPrimary = yamlList(body, 'required_validation');
  const validationFallback = validationPrimary.length ? validationPrimary : yamlList(body, 'validation');

  const fail = (reason) => Object.freeze({
    ok: false,
    reason,
    filePath: null,
    task: null,
    validationCommands: Object.freeze([]),
  });

  if (scope.length !== 2) return fail('ollama-manager-scope-shape-unsupported');
  const fileItems = scope.filter((item) => item.startsWith('file: '));
  const taskItems = scope.filter((item) => item.startsWith('task: '));
  if (fileItems.length !== 1 || taskItems.length !== 1) {
    return fail('ollama-manager-scope-shape-unsupported');
  }

  const filePath = fileItems[0].slice('file: '.length).trim();
  const task = taskItems[0].slice('task: '.length).trim();
  if (!isSafeOllamaWorkerPath(filePath)) return fail('ollama-manager-file-path-invalid');
  if (!task || task.length > MAX_TASK_CHARS || /[\0\r\n]/.test(task)) {
    return fail('ollama-manager-task-invalid');
  }
  if (validationFallback.length < 1 || validationFallback.length > 8) {
    return fail('ollama-manager-validation-shape-unsupported');
  }
  if (validationFallback.some((command) => !command || command.length > 500 || /[\0\r\n]/.test(command))) {
    return fail('ollama-manager-validation-shape-unsupported');
  }

  return Object.freeze({
    ok: true,
    reason: null,
    filePath,
    task,
    validationCommands: Object.freeze([...validationFallback]),
  });
}

export function buildBoundedOllamaCodingPrompt({
  filePath,
  task,
  allowedCommands = [],
} = {}) {
  if (!isSafeOllamaWorkerPath(filePath)) throw new Error('invalid bounded Ollama file path');
  const instruction = String(task || '').trim();
  if (!instruction || instruction.length > MAX_TASK_CHARS || /[\0\r\n]/.test(instruction)) {
    throw new Error('invalid bounded Ollama task');
  }
  const commands = Array.isArray(allowedCommands)
    ? allowedCommands.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  return [
    'Perform one bounded low-risk repository edit.',
    `Target file: ${filePath}`,
    `Task: ${instruction}`,
    'Read and edit only the target file.',
    'Use shell only for the exact commands explicitly admitted below; all other shell requests are denied:',
    ...commands.map((command) => `- ${command}`),
    'Do not commit, push, merge, change branches, install packages, download anything, access external directories, inspect credentials, or administer the host.',
    'Make the smallest complete change, use an admitted validation command when useful, and then stop.',
  ].join('\n');
}

export function exactChangedPath(statusEntry = '') {
  const entry = String(statusEntry || '');
  if (entry.length < 4) return null;
  return entry.slice(3);
}

export function changedPathsFromPorcelainZ(bytes = '') {
  return String(bytes || '')
    .split('\0')
    .filter(Boolean)
    .map(exactChangedPath)
    .filter(Boolean);
}
