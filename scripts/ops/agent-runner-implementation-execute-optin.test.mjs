import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = path.join(repoRoot, 'bin/run-implementation-recurrence.sh');
const service = path.join(repoRoot, 'systemd/user/agent-runner-implementation.service');

test('generic implementation service explicitly opts into execution', async () => {
  const contents = await readFile(service, 'utf8');
  assert.match(
    contents,
    /^ExecStart=\/bin\/bash \$\{AGENT_RUNNER_HOME\}\/bin\/run-implementation-recurrence\.sh --execute$/m,
  );
});

test('implementation recurrence wrapper forwards execute authority while stripping shared project identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-runner-execute-optin-'));
  const fakeBin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const configDir = path.join(home, '.config', 'agent-runner');
  const argsLog = path.join(root, 'node-args.log');
  const envLog = path.join(root, 'node-env.log');
  const registry = path.join(root, 'projects.json');
  const fakeNode = path.join(root, 'fake-node');
  const runnerEnv = path.join(configDir, 'runner.env');

  await mkdir(fakeBin, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(registry, '{"schemaVersion":1,"defaultProjectId":"fixture","projects":[]}\n');
  await writeFile(
    runnerEnv,
    [
      'GITHUB_REPOSITORY=TheTekTeam/modelspend',
      'CLAUDE_RUNNER_OUTPUT_DIR=/tmp/modelspend/output',
      'CLAUDE_RUNNER_STATE_DB=/tmp/modelspend/state.sqlite',
      'CLAUDE_RUNNER_CRON_LOCK=/tmp/modelspend/cron.lock',
      'GLOBAL_POLICY_MARKER=preserved',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(fakeBin, 'id'),
    '#!/usr/bin/env bash\nif [ "${1:-}" = "-u" ]; then printf "1000\\n"; else exec /usr/bin/id "$@"; fi\n',
    { mode: 0o755 },
  );
  await writeFile(
    fakeNode,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$FAKE_NODE_ARGS_LOG"
{
  printf 'AGENT_RUNNER_EXECUTE=%s\\n' "\${AGENT_RUNNER_EXECUTE-}"
  printf 'AGENT_RUNNER_ENV_FILE=%s\\n' "\${AGENT_RUNNER_ENV_FILE-}"
  printf 'GITHUB_REPOSITORY=%s\\n' "\${GITHUB_REPOSITORY-}"
  printf 'CLAUDE_RUNNER_OUTPUT_DIR=%s\\n' "\${CLAUDE_RUNNER_OUTPUT_DIR-}"
  printf 'CLAUDE_RUNNER_STATE_DB=%s\\n' "\${CLAUDE_RUNNER_STATE_DB-}"
  printf 'CLAUDE_RUNNER_CRON_LOCK=%s\\n' "\${CLAUDE_RUNNER_CRON_LOCK-}"
  printf 'GLOBAL_POLICY_MARKER=%s\\n' "\${GLOBAL_POLICY_MARKER-}"
} > "$FAKE_NODE_ENV_LOG"
`,
    { mode: 0o755 },
  );

  const result = spawnSync('bash', [wrapper, '--execute'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      AGENT_RUNNER_NODE_BIN: fakeNode,
      AGENT_RUNNER_PROJECT_REGISTRY: registry,
      FAKE_NODE_ARGS_LOG: argsLog,
      FAKE_NODE_ENV_LOG: envLog,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const args = (await readFile(argsLog, 'utf8')).trim().split('\n');
  assert.match(args[0], /scripts\/ops\/agent-runner-implementation-recurrence\.mjs$/);
  assert.deepEqual(args.slice(1), ['--execute']);

  const envLines = Object.fromEntries(
    (await readFile(envLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  assert.equal(envLines.AGENT_RUNNER_EXECUTE, 'true');
  assert.equal(envLines.AGENT_RUNNER_ENV_FILE, '/dev/null');
  assert.equal(envLines.GITHUB_REPOSITORY, '');
  assert.equal(envLines.CLAUDE_RUNNER_OUTPUT_DIR, '');
  assert.equal(envLines.CLAUDE_RUNNER_STATE_DB, '');
  assert.equal(envLines.CLAUDE_RUNNER_CRON_LOCK, '');
  assert.equal(envLines.GLOBAL_POLICY_MARKER, 'preserved');
});

test('implementation recurrence wrapper rejects unrelated CLI arguments before invoking the recurrence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-runner-execute-optin-reject-'));
  const fakeBin = path.join(root, 'bin');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    path.join(fakeBin, 'id'),
    '#!/usr/bin/env bash\nif [ "${1:-}" = "-u" ]; then printf "1000\\n"; else exec /usr/bin/id "$@"; fi\n',
    { mode: 0o755 },
  );

  const result = spawnSync('bash', [wrapper, '--unexpected'], {
    cwd: repoRoot,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported implementation recurrence argument/);
});
