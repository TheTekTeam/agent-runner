import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installer = path.join(repoRoot, 'scripts/ops/install-claude-runner-systemd.sh');

async function createHarness({
  nextRealtime = 'n/a',
  nextMonotonic = '10min',
  activeExit = '0',
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'modelspend-systemd-installer-'));
  const configHome = path.join(root, 'config');
  const fakeBin = path.join(root, 'bin');
  const logPath = path.join(root, 'systemctl.log');

  await mkdir(fakeBin, { recursive: true });
  await mkdir(path.join(configHome, 'modelspend'), { recursive: true });
  await mkdir(path.join(configHome, 'systemd', 'user'), { recursive: true });

  await writeFile(
    path.join(fakeBin, 'id'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  -u) printf '%s\\n' 1000 ;;
  -un) printf '%s\\n' test-operator ;;
  *) exec /usr/bin/id "$@" ;;
esac
`,
    { mode: 0o755 },
  );

  const fakeSystemctl = path.join(fakeBin, 'systemctl');
  await writeFile(
    fakeSystemctl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"

if [[ "$*" == *" is-active --quiet modelspend-claude-runner.timer"* ]]; then
  exit "${activeExit}"
fi

if [[ "$*" == *" show modelspend-claude-runner.timer"* ]] && [[ "$*" == *"NextElapseUSecRealtime"* ]]; then
  printf '%s\\n' "${nextRealtime}"
  exit 0
fi

if [[ "$*" == *" show modelspend-claude-runner.timer"* ]] && [[ "$*" == *"NextElapseUSecMonotonic"* ]]; then
  printf '%s\\n' "${nextMonotonic}"
  exit 0
fi

exit 0
`,
    { mode: 0o755 },
  );

  return {
    root,
    configHome,
    envFile: path.join(configHome, 'modelspend', 'claude-runner.env'),
    unitDir: path.join(configHome, 'systemd', 'user'),
    logPath,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      XDG_CONFIG_HOME: configHome,
      MODELSPEND_REPO_DIR: repoRoot,
      FAKE_SYSTEMCTL_LOG: logPath,
    },
  };
}

function runInstaller(harness, args = []) {
  return spawnSync('bash', [installer, ...args], {
    cwd: repoRoot,
    env: harness.env,
    encoding: 'utf8',
  });
}

async function writeEnv(harness, lines, mode = 0o600) {
  await writeFile(harness.envFile, `${lines.join('\n')}\n`, { mode });
  await chmod(harness.envFile, mode);
}

test('installer shell syntax is valid', () => {
  const result = spawnSync('bash', ['-n', installer], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
});

test('explicit provisioning normalizes approvers, collapses managed duplicates, preserves secrets and mode, and disables generated preflights', async () => {
  const harness = await createHarness();
  await writeEnv(harness, [
    'MODELSPEND_REPO_DIR=/old/path',
    'CLAUDE_RUNNER_CRON_EXECUTE=false',
    'CLAUDE_RUNNER_CRON_EXECUTE=false',
    'CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=false',
    'CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=false',
    'CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=old-login',
    'export CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=other-login',
    'CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION=true',
    'CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION=true',
    'GH_TOKEN=do-not-print-this-value',
  ], 0o640);

  const result = runInstaller(harness, [
    '--execute',
    '--allow-implementation',
    '--implementation-approvers',
    ' GpCola,second-user,GPCOLA ',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const envContents = await readFile(harness.envFile, 'utf8');
  assert.match(envContents, /^CLAUDE_RUNNER_CRON_EXECUTE=true$/m);
  assert.match(envContents, /^CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true$/m);
  assert.match(envContents, /^CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=gpcola,second-user$/m);
  assert.match(envContents, /^CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION=false$/m);
  for (const key of [
    'CLAUDE_RUNNER_CRON_EXECUTE',
    'CLAUDE_RUNNER_ALLOW_IMPLEMENTATION',
    'CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS',
    'CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION',
  ]) {
    assert.equal((envContents.match(new RegExp(`^${key}=`, 'gm')) ?? []).length, 1);
  }
  assert.match(envContents, /^GH_TOKEN=do-not-print-this-value$/m);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /do-not-print-this-value/);
  assert.equal((await stat(harness.envFile)).mode & 0o777, 0o640);

  const timerContents = await readFile(
    path.join(harness.unitDir, 'modelspend-claude-runner.timer'),
    'utf8',
  );
  assert.match(timerContents, /^OnActiveSec=2min$/m);
  assert.match(timerContents, /^OnUnitInactiveSec=10min$/m);
  assert.match(timerContents, /^Persistent=false$/m);
  assert.doesNotMatch(timerContents, /^OnBootSec=/m);
  assert.doesNotMatch(timerContents, /^OnUnitActiveSec=/m);

  const systemctlLog = await readFile(harness.logPath, 'utf8');
  assert.match(systemctlLog, /--user daemon-reload/);
  assert.match(systemctlLog, /--user enable modelspend-claude-runner\.timer/);
  assert.match(systemctlLog, /--user restart modelspend-claude-runner\.timer/);
  assert.doesNotMatch(systemctlLog, /enable --now/);
  assert.match(systemctlLog, /NextElapseUSecMonotonic/);
});

test('--allow-implementation fails when no approvers exist or are supplied', async () => {
  const harness = await createHarness();

  const result = runInstaller(harness, ['--allow-implementation']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --implementation-approvers/);
  await assert.rejects(readFile(harness.logPath, 'utf8'), { code: 'ENOENT' });
});

test('empty implementation approvers are rejected', async () => {
  const harness = await createHarness();

  const result = runInstaller(harness, [
    '--allow-implementation',
    '--implementation-approvers',
    '',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-empty comma-separated list/);
});

test('missing implementation approver option value is rejected', async () => {
  const harness = await createHarness();

  const result = runInstaller(harness, ['--implementation-approvers']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing --implementation-approvers value/);
});

test('malformed implementation approver lists are rejected', async () => {
  for (const approvers of [
    'gpcola,,second-user',
    'gpcola,',
    '-gpcola',
    'gp--cola',
    'gp_cola',
    `${'a'.repeat(40)}`,
  ]) {
    const harness = await createHarness();
    const result = runInstaller(harness, [
      '--allow-implementation',
      '--implementation-approvers',
      approvers,
    ]);
    assert.equal(result.status, 1, approvers);
    assert.match(result.stderr, /valid GitHub logins/, approvers);
  }
});

test('--allow-implementation accepts and normalizes a valid existing approver list', async () => {
  const harness = await createHarness();
  await writeEnv(harness, [
    'CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS= GpCola,GPCola,second-user ',
    'GH_TOKEN=preserved-secret',
  ]);

  const result = runInstaller(harness, ['--allow-implementation']);
  assert.equal(result.status, 0, result.stderr);

  const envContents = await readFile(harness.envFile, 'utf8');
  assert.match(envContents, /^CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=true$/m);
  assert.match(envContents, /^CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=gpcola,second-user$/m);
  assert.match(envContents, /^CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION=false$/m);
  assert.match(envContents, /^GH_TOKEN=preserved-secret$/m);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /preserved-secret/);
});

test('approvers can be provisioned without silently enabling implementation', async () => {
  const harness = await createHarness();

  const result = runInstaller(harness, [
    '--implementation-approvers',
    'GpCola',
  ]);
  assert.equal(result.status, 0, result.stderr);

  const envContents = await readFile(harness.envFile, 'utf8');
  assert.match(envContents, /^CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=false$/m);
  assert.match(envContents, /^CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=gpcola$/m);
  assert.match(envContents, /^CLAUDE_RUNNER_ALLOW_GENERATED_PREFLIGHT_IMPLEMENTATION=false$/m);
});

test('custom interval is written as OnUnitInactiveSec', async () => {
  const harness = await createHarness();

  const result = runInstaller(harness, ['--execute', '--interval', '15min']);
  assert.equal(result.status, 0, result.stderr);

  const timerContents = await readFile(
    path.join(harness.unitDir, 'modelspend-claude-runner.timer'),
    'utf8',
  );
  assert.match(timerContents, /^OnUnitInactiveSec=15min$/m);
});

test('installer rejects an active timer whose NEXT values are dash or otherwise empty', async () => {
  const harness = await createHarness({
    nextRealtime: '-',
    nextMonotonic: 'n/a',
  });

  const result = runInstaller(harness, ['--execute']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /active but has no next trigger/);
});

test('installer fails on service drop-ins that override implementation authorisation', async () => {
  const harness = await createHarness();
  const dropinDir = path.join(
    harness.unitDir,
    'modelspend-claude-runner.service.d',
  );
  const dropinPath = path.join(dropinDir, '10-read-only-proof.conf');

  await mkdir(dropinDir, { recursive: true });
  await writeFile(
    dropinPath,
    '[Service]\nEnvironment=CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=false\n',
  );

  const result = runInstaller(harness, [
    '--execute',
    '--allow-implementation',
    '--implementation-approvers',
    'gpcola',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /10-read-only-proof\.conf/);
  assert.match(result.stderr, /service drop-ins override the runner env\/execute contract/);
});

test('--dry-run preserves the env file and mode, invokes no systemctl, and redacts secrets', async () => {
  const harness = await createHarness();
  const original = [
    'CLAUDE_RUNNER_CRON_EXECUTE=false',
    'CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=false',
    'CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS=old-login',
    'GH_TOKEN=dry-run-secret',
    '',
  ].join('\n');
  await writeFile(harness.envFile, original, { mode: 0o640 });
  await chmod(harness.envFile, 0o640);

  const before = await readFile(harness.envFile, 'utf8');
  const result = runInstaller(harness, [
    '--execute',
    '--allow-implementation',
    '--implementation-approvers',
    'GpCola',
    '--dry-run',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(harness.envFile, 'utf8'), before);
  assert.equal((await stat(harness.envFile)).mode & 0o777, 0o640);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /dry-run-secret/);
  assert.match(result.stdout, /OnActiveSec=2min/);
  assert.match(result.stdout, /OnUnitInactiveSec=10min/);
  assert.match(result.stdout, /normalized approvers/);
  assert.match(result.stdout, /daemon-reload, enable, restart, and verify a next trigger/);
  await assert.rejects(readFile(harness.logPath, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(
    readFile(path.join(harness.unitDir, 'modelspend-claude-runner.service'), 'utf8'),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    readFile(path.join(harness.unitDir, 'modelspend-claude-runner.timer'), 'utf8'),
    { code: 'ENOENT' },
  );
});

test('new-file dry-run never prints the complete env template', async () => {
  const harness = await createHarness();

  const result = runInstaller(harness, [
    '--execute',
    '--allow-implementation',
    '--implementation-approvers',
    'gpcola',
    '--dry-run',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /without printing its contents/);
  assert.doesNotMatch(
    result.stdout,
    /GITHUB_TOKEN=|GH_TOKEN=|CLAUDE_RUNNER_CRON_EXECUTE=|CLAUDE_RUNNER_ALLOW_IMPLEMENTATION=/,
  );
  await assert.rejects(readFile(harness.envFile, 'utf8'), { code: 'ENOENT' });
});
