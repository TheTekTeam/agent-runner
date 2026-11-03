#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import {
  readTrustedProxyOrigin,
  removeTrustedProxyOrigin,
  setTrustedProxyOrigin,
} from './agent-runner-control-trusted-origin.mjs';

function usage() {
  return 'Usage: node scripts/ops/agent-runner-control-trusted-origin-cli.mjs <set HTTPS_ORIGIN|show|remove>\n';
}

export function run(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, value, ...rest] = argv;
  if (command === 'set' && value && rest.length === 0) {
    const origin = setTrustedProxyOrigin({ origin: value });
    io.stdout.write(`Trusted proxy origin configured: ${origin}\n`);
    return 0;
  }
  if (command === 'show' && value === undefined) {
    const origin = readTrustedProxyOrigin();
    io.stdout.write(origin ? `${origin}\n` : 'not configured\n');
    return 0;
  }
  if (command === 'remove' && value === undefined) {
    const removed = removeTrustedProxyOrigin();
    io.stdout.write(removed ? 'Trusted proxy origin removed\n' : 'Trusted proxy origin was not configured\n');
    return 0;
  }
  if (command === '-h' || command === '--help') {
    io.stdout.write(usage());
    return 0;
  }
  io.stderr.write(usage());
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = run();
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
