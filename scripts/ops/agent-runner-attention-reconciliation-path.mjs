import { join } from 'node:path';

export function resolveRunnerOutputDir(env = process.env, config = {}) {
  return env.CLAUDE_RUNNER_OUTPUT_DIR || config.outputDir || '.var/claude-runner';
}

export function resolveAttentionReconciliationDbPath({ explicitPath = null, env = process.env, config = {} } = {}) {
  return explicitPath
    || env.CLAUDE_RUNNER_ATTENTION_RECONCILIATION_DB
    || join(resolveRunnerOutputDir(env, config), 'attention-reconciliation.sqlite');
}
