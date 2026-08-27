// Strict live-executor contract for the positively qualified #152 Ollama coding profile.
//
// Existing manager-preflight scope/validation values are authored text, not
// arbitrary shell/filesystem authority. This module accepts only the tiny
// structured subset proven by the supervised canary:
//   scope:
//     - file: <one safe repository-relative path>
//     - task: <one bounded instruction>
//   required_validation:
//     - node --test <one safe repository-relative test path>
//
// Everything else fails closed before a worker/model launch.

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
    validationPath: null,
    validationArgs: null,
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

  if (validationFallback.length !== 1) return fail('ollama-manager-validation-shape-unsupported');
  const match = validationFallback[0].match(/^node --test ([A-Za-z0-9][A-Za-z0-9._/-]*)$/);
  if (!match || !isSafeOllamaWorkerPath(match[1])) {
    return fail('ollama-manager-validation-unsupported');
  }
  const validationPath = match[1];

  return Object.freeze({
    ok: true,
    reason: null,
    filePath,
    task,
    validationPath,
    validationArgs: Object.freeze(['--test', validationPath]),
  });
}

export function buildBoundedOllamaCodingPrompt({ filePath, task } = {}) {
  if (!isSafeOllamaWorkerPath(filePath)) throw new Error('invalid bounded Ollama file path');
  const instruction = String(task || '').trim();
  if (!instruction || instruction.length > MAX_TASK_CHARS || /[\0\r\n]/.test(instruction)) {
    throw new Error('invalid bounded Ollama task');
  }
  return [
    'Perform one bounded low-risk repository edit.',
    `Target file: ${filePath}`,
    `Task: ${instruction}`,
    'Read and edit only the target file.',
    'Do not use shell commands, search other files, access external directories, change configuration, or perform Git/GitHub actions.',
    'Make the smallest complete change and then stop.',
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
