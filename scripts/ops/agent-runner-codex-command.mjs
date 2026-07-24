/**
 * Bounded, Codex-native command construction (issue #48).
 *
 * The flag surface here is grounded in `codex exec --help` captured locally
 * against the installed `codex-cli 0.144.6` binary (a no-cost, non-model
 * command run at implementation time) rather than copied from Claude's CLI
 * shape:
 *
 *   codex exec [OPTIONS] [PROMPT]
 *     -s, --sandbox <read-only|workspace-write|danger-full-access>
 *     -m, --model <MODEL>
 *     -C, --cd <DIR>
 *     --json
 *     --output-schema <FILE>
 *     -c, --config <key=value>
 *
 * `exec` has no dedicated `-a/--ask-for-approval` flag (that only appears on
 * the top-level interactive `codex --help`, with values `untrusted`,
 * `on-request`, `never`); this module reaches the same `approval_policy`
 * config field through the documented generic `-c key=value` override
 * instead. There is no `--timeout`, `--cancel`, `--worktree`, or
 * concurrency/fallback flag in the captured help output, so timeout,
 * cancellation, and worktree isolation are enforced by the caller (an
 * explicit, required `cwd` here; process-level timeout/cancellation in
 * `agent-runner-codex-parser.mjs`'s `classifyCodexExecutionError`), not by a
 * CLI switch. This function only builds an argv array — it never spawns
 * anything.
 */

export const CODEX_EXEC_SUBCOMMAND = 'exec';

export const CODEX_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);
export const CODEX_APPROVAL_POLICIES = Object.freeze(['untrusted', 'on-request', 'never']);
export const CODEX_REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high']);

/**
 * Config keys reached only through the documented `-c key=value` override,
 * never a bespoke/undocumented flag.
 */
const APPROVAL_POLICY_CONFIG_KEY = 'approval_policy';
const REASONING_EFFORT_CONFIG_KEY = 'model_reasoning_effort';

function requireNonEmptyString(value, label) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error(`buildCodexCommandArgs requires ${label}`);
  return raw;
}

function requireEnum(value, allowed, label) {
  const raw = requireNonEmptyString(value, label);
  if (!allowed.includes(raw)) {
    throw new Error(`buildCodexCommandArgs received an unsupported ${label}: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Every argument is explicit and required except `reasoningEffort` and
 * `outputSchemaPath`, which are simply omitted (not defaulted) when unset.
 * There is no code path in this function that can ever emit
 * `--dangerously-bypass-approvals-and-sandbox` or
 * `--dangerously-bypass-hook-trust` — those flags have no corresponding
 * parameter at all, not merely a parameter defaulted to off.
 */
export function buildCodexCommandArgs({
  executablePath,
  cwd,
  model,
  sandboxMode,
  approvalMode,
  reasoningEffort,
  outputSchemaPath,
  prompt,
} = {}) {
  const resolvedExecutable = requireNonEmptyString(executablePath, 'an executable path');
  const resolvedCwd = requireNonEmptyString(cwd, 'an explicit worktree cwd');
  const resolvedModel = requireNonEmptyString(model, 'a model');
  const resolvedSandbox = requireEnum(sandboxMode, CODEX_SANDBOX_MODES, 'a sandbox mode');
  const resolvedApproval = requireEnum(approvalMode, CODEX_APPROVAL_POLICIES, 'an approval mode');
  const resolvedPrompt = requireNonEmptyString(prompt, 'a prompt');

  const args = [
    resolvedExecutable,
    CODEX_EXEC_SUBCOMMAND,
    '--json',
    '-C', resolvedCwd,
    '-s', resolvedSandbox,
    '-c', `${APPROVAL_POLICY_CONFIG_KEY}=${resolvedApproval}`,
    '-m', resolvedModel,
  ];

  if (reasoningEffort !== undefined && reasoningEffort !== null) {
    const resolvedEffort = requireEnum(reasoningEffort, CODEX_REASONING_EFFORTS, 'a reasoning effort');
    args.push('-c', `${REASONING_EFFORT_CONFIG_KEY}=${resolvedEffort}`);
  }

  if (typeof outputSchemaPath === 'string' && outputSchemaPath.trim()) {
    args.push('--output-schema', outputSchemaPath.trim());
  }

  args.push(resolvedPrompt);
  return args;
}
