#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  parseSupervisedCanaryArgs,
  runSupervisedCanary,
} from './agent-runner-supervised-canary-core.mjs';
import {
  applySupervisedCanaryRuntime,
  resolveSupervisedCanaryRuntime,
} from './agent-runner-supervised-runtime.mjs';

export * from './agent-runner-supervised-canary-core.mjs';
export {
  applySupervisedCanaryRuntime,
  resolveSupervisedCanaryRuntime,
} from './agent-runner-supervised-runtime.mjs';

export function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const runtime = dependencies.runtime
    || resolveSupervisedCanaryRuntime(env, dependencies.runtimeDependencies || {});
  const args = parseSupervisedCanaryArgs(argv);
  const result = runSupervisedCanary(
    args,
    runtime.env,
    applySupervisedCanaryRuntime(runtime, dependencies),
  );
  result.payload.runtimeResolution = {
    policyRevision: 'supervised-canary-runtime/v1',
    configPath: runtime.configPath,
    envFilePath: runtime.envFilePath,
    envFileLoaded: runtime.envFileLoaded,
    stateDbPath: runtime.stateDbPath,
    outputDir: runtime.outputDir,
    workingDirectory: runtime.workingDirectory,
  };
  console.log(JSON.stringify(result.payload, null, 2));
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: 'agent-runner-supervised-canary/v2',
      launched: false,
      systemicFailure: true,
      reason: String(error?.message || error),
      safeNextAction: 'Keep the timer disabled and repair the supervised canary runtime prerequisites.',
    }, null, 2));
    process.exitCode = 1;
  }
}
