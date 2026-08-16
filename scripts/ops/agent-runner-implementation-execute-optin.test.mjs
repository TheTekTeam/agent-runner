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

test('implementation recurrence wrapper forwards the explicit --execute opt-in to the recurrence script', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-runner-execute-optin-'));
  const fakeBin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const argsLog = path.join(root, 'node-args.log');
  const registry = path.join(root, 'projects.json');
  const fakeNode = path.join(root, 'fake-node');

  await mkdir(fakeBin, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(registry, '{"schemaVersion":1,"defaultProjectId":"fixture","projects":[]}\n');
  await writeFile(
    path.join(fakeBin, 'id'),
    '#!/usr/bin/env bash\nif [ "${1:-}" = "-u" ]; then printf "1000\\n"; else exec /usr/bin/id "$@"; fi\n',
    { mode: 0o755 },
  );
  await writeFile(
    fakeNode,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$FAKE_NODE_ARGS_LOG"\n',
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
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const args = (await readFile(argsLog, 'utf8')).trim().split('\n');
  assert.match(args[0], /scripts\/ops\/agent-runner-implementation-recurrence\.mjs$/);
  assert.deepEqual(args.slice(1), ['--execute']);
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
