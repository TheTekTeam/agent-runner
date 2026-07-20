#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { runPortableEntrypoint } from './standalone-entrypoint.mjs';

export function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  return runPortableEntrypoint({
    scriptUrl: import.meta.url,
    scriptName: 'runner-cron.mjs',
    legacyModuleUrl: new URL('../../scripts/ops/agent-runner-atomic-cron.mjs', import.meta.url).href,
    argv,
    env,
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
