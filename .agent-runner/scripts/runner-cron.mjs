#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { runPortableEntrypoint } from './standalone-entrypoint.mjs';
import {
  admitMachineProfile,
  machineProfilePausePayload,
} from '../../scripts/ops/agent-runner-admission.mjs';

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const admission = admitMachineProfile({ argv, env });
  if (!admission.allowed) {
    const payload = machineProfilePausePayload(admission);
    (dependencies.logger || console).log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const safeEnv = {
    ...env,
    CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT: 'true',
    CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION: 'false',
  };

  return runPortableEntrypoint({
    scriptUrl: import.meta.url,
    scriptName: 'runner-cron.mjs',
    legacyModuleUrl: new URL('../../scripts/ops/claude-runner-cron.mjs', import.meta.url).href,
    argv,
    env: safeEnv,
    dependencies,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
