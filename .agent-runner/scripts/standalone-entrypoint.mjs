import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const DEFAULT_STANDALONE_ROOT = '/home/gp/projects/agent-runner';

export function runnerRepositoryRoot(scriptUrl) {
  return resolve(dirname(fileURLToPath(scriptUrl)), '../..');
}

export function resolveStandaloneTarget({ scriptUrl, scriptName, env = process.env }) {
  const currentRoot = runnerRepositoryRoot(scriptUrl);
  const standaloneRoot = resolve(env.AGENT_RUNNER_HOME || DEFAULT_STANDALONE_ROOT);
  const target = resolve(standaloneRoot, '.agent-runner/scripts', scriptName);
  return {
    currentRoot,
    standaloneRoot,
    target,
    shouldDispatch: currentRoot !== standaloneRoot
      && env.AGENT_RUNNER_STANDALONE_DISPATCHED !== '1'
      && existsSync(target),
  };
}

export async function runPortableEntrypoint({
  scriptUrl,
  scriptName,
  legacyModuleUrl,
  argv = process.argv.slice(2),
  env = process.env,
  dependencies = {},
}) {
  const spawn = dependencies.spawnSync || spawnSync;
  const importModule = dependencies.importModule || ((url) => import(url));
  const resolved = dependencies.resolveStandaloneTarget
    ? dependencies.resolveStandaloneTarget({ scriptUrl, scriptName, env })
    : resolveStandaloneTarget({ scriptUrl, scriptName, env });

  if (resolved.shouldDispatch) {
    const result = spawn(process.execPath, [resolved.target, ...argv], {
      stdio: 'inherit',
      env: {
        ...env,
        AGENT_RUNNER_HOME: resolved.standaloneRoot,
        AGENT_RUNNER_STANDALONE_DISPATCHED: '1',
      },
    });
    if (result.error) throw result.error;
    return Number.isInteger(result.status) ? result.status : 1;
  }

  const implementation = await importModule(legacyModuleUrl);
  if (typeof implementation.main !== 'function') {
    throw new Error(`Runner implementation does not export main(): ${legacyModuleUrl}`);
  }
  return implementation.main(argv, env);
}
