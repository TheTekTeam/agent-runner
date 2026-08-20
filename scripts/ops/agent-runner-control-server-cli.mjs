export const CONTROL_CLI_HOST = '127.0.0.1';
export const DEFAULT_CONTROL_CLI_PORT = 8789;

export function parseControlCliPort(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value)) {
    const error = new Error('control server --port must be a canonical decimal integer from 1 to 65535');
    error.code = 'AGENT_RUNNER_CONTROL_INVALID_PORT';
    throw error;
  }
  const port = Number(value);
  if (port > 65535) {
    const error = new Error('control server --port must be in range 1..65535');
    error.code = 'AGENT_RUNNER_CONTROL_INVALID_PORT';
    throw error;
  }
  return port;
}

export function parseControlServerCliArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return Object.freeze({ help: true, host: CONTROL_CLI_HOST, port: DEFAULT_CONTROL_CLI_PORT });
  }

  let port = DEFAULT_CONTROL_CLI_PORT;
  let seenPort = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--port') {
      const error = new Error(`unknown control server argument: ${String(argument)}`);
      error.code = 'AGENT_RUNNER_CONTROL_UNKNOWN_ARGUMENT';
      throw error;
    }
    if (seenPort) {
      const error = new Error('duplicate control server --port argument');
      error.code = 'AGENT_RUNNER_CONTROL_DUPLICATE_PORT';
      throw error;
    }
    if (index + 1 >= argv.length) {
      const error = new Error('missing value for control server --port');
      error.code = 'AGENT_RUNNER_CONTROL_INVALID_PORT';
      throw error;
    }
    port = parseControlCliPort(argv[index + 1]);
    seenPort = true;
    index += 1;
  }
  return Object.freeze({ help: false, host: CONTROL_CLI_HOST, port });
}

export function controlServerHelpText() {
  return 'Usage: node scripts/ops/agent-runner-control-server.mjs [--port PORT]\n\n'
    + 'Runs the permanent authenticated control dashboard on 127.0.0.1:8789 by default.\n'
    + 'The production CLI accepts only canonical ports 1..65535 and never accepts a host override.\n'
    + 'Bootstrap the operator credential separately before first use.\n';
}
