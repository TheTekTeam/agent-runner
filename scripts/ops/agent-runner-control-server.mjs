#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { createControlServer, listenControlServer } from './agent-runner-control-server-core.mjs';
import {
  controlServerHelpText,
  parseControlServerCliArgs,
} from './agent-runner-control-server-cli.mjs';

export * from './agent-runner-control-server-core.mjs';
export { parseControlCliPort, parseControlServerCliArgs } from './agent-runner-control-server-cli.mjs';

export async function run(argv = process.argv.slice(2), env = process.env, io = { stdout: process.stdout, stderr: process.stderr }) {
  const parsed = parseControlServerCliArgs(argv);
  if (parsed.help) {
    io.stdout.write(controlServerHelpText());
    return 0;
  }

  const server = createControlServer({ env, host: parsed.host });
  await listenControlServer(server, { host: parsed.host, port: parsed.port });
  const address = server.address();
  io.stdout.write(`Agent Runner control service listening on http://${address.address}:${address.port}\n`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
