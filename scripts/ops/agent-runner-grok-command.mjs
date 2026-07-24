/**
 * Bounded, Grok-native command construction (issue #49).
 *
 * The flag surface here is grounded in `grok --help` and `grok --version`
 * captured locally against the installed `grok 1.1.7` binary
 * (`/home/gp/.grok/bin/grok`, installed from `superagent-ai/grok-cli` via
 * GitHub Releases per `~/.grok/install.json`) — a no-cost, non-model,
 * non-network command run at implementation time — rather than copied from
 * Claude's or Codex's CLI shape:
 *
 *   Usage: grok [options] [command] [message...]
 *     -k, --api-key <key>            Grok API key
 *     -u, --base-url <url>           API base URL
 *     -m, --model <model>            Model to use
 *     -d, --directory <dir>          Working directory
 *     -p, --prompt <prompt>          Run a single prompt headlessly
 *     --verify                       Run the built-in verify flow headlessly
 *     --format <format>              Headless output format: text or json
 *     --sandbox / --no-sandbox       Run agent shell commands inside/outside
 *                                    a Shuru sandbox
 *     --allow-net                    Enable network access inside the
 *                                    sandbox
 *     --allow-host <pattern>         Restrict sandbox network to hosts
 *     --port <mapping>                Forward a host port to sandbox guest
 *     -s, --session <id>             Continue a saved session
 *     --background-task-file <path>  Run a persisted background delegation
 *     --max-tool-rounds <n>          Max tool execution rounds (default 400)
 *     --batch-api                    Use xAI Batch API for model calls
 *   Commands: telegram-bridge, models, update, uninstall, wallet, daemon
 *
 * This module deliberately narrows that surface to a bounded, safe subset:
 * an explicit working directory, an explicit model only when configured,
 * structured `--format json` output, a bounded `--max-tool-rounds`, and the
 * CLI's own sandbox confinement flag as the only "verification control" this
 * foundation trusts. There is no parameter — and therefore no code path —
 * for `--api-key`, `--base-url`, `--session`, `--allow-net`, `--allow-host`,
 * `--port`, `--background-task-file`, `--batch-api`, `--verify`, or any of
 * the `telegram-bridge`/`models`/`update`/`uninstall`/`wallet`/`daemon`
 * subcommands: those are, respectively, credential/session material, sandbox
 * network escape hatches, a remote-control/background-delegation surface, a
 * Batch API path, a model-backed self-verification flow, and a
 * remote-control/model-listing/self-update/payment-wallet/scheduling
 * surface, all explicitly out of scope for this foundation. `--sandbox` is
 * always emitted and there is no code path that can ever emit
 * `--no-sandbox` — sandboxing is a fixed safety default, not a caller
 * choice. This function only builds an argv array — it never spawns
 * anything.
 */

export const GROK_MAX_TOOL_ROUNDS_CEILING = 400;

function requireNonEmptyString(value, label) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error(`buildGrokCommandArgs requires ${label}`);
  return raw;
}

function requireBoundedToolRounds(value, { max = GROK_MAX_TOOL_ROUNDS_CEILING } = {}) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > max) {
    throw new Error(`buildGrokCommandArgs requires a bounded maximum tool-round count between 1 and ${max}`);
  }
  return num;
}

/**
 * Every argument is explicit and required except `model`, which is simply
 * omitted (never defaulted/guessed) when unset. `--format json`,
 * `--sandbox`, and `--max-tool-rounds` are always present; there is no
 * parameter through which a caller could suppress them or request
 * `--no-sandbox`, `--allow-net`, `--batch-api`, `--verify`, `-k`, `-u`, or
 * `-s`.
 */
export function buildGrokCommandArgs({
  executablePath,
  cwd,
  model,
  maxToolRounds,
  prompt,
} = {}) {
  const resolvedExecutable = requireNonEmptyString(executablePath, 'an executable path');
  const resolvedCwd = requireNonEmptyString(cwd, 'an explicit isolated working directory');
  const resolvedPrompt = requireNonEmptyString(prompt, 'a prompt');
  const resolvedMaxToolRounds = requireBoundedToolRounds(maxToolRounds);

  const args = [
    resolvedExecutable,
    '-d', resolvedCwd,
  ];

  if (model !== undefined && model !== null && String(model).trim()) {
    args.push('-m', String(model).trim());
  }

  args.push(
    '--format', 'json',
    '--sandbox',
    '--max-tool-rounds', String(resolvedMaxToolRounds),
    '-p', resolvedPrompt,
  );

  return args;
}
