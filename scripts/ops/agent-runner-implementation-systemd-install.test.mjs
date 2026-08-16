import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installer = path.join(repoRoot, 'scripts/install-agent-runner-implementation-systemd.sh');
const GENERIC_TIMER = 'agent-runner-implementation.timer';
const LEGACY_TIMER = 'agent-runner-modelspend.timer';

async function createHarness({ legacyInstalled = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-runner-implementation-systemd-install-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const stateDir = path.join(root, 'systemctl-state');
  const logPath = path.join(root, 'systemctl.log');

  await mkdir(fakeBin, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(path.join(home, '.config', 'systemd', 'user'), { recursive: true });

  await writeFile(
    path.join(fakeBin, 'id'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  -u) printf '%s\\n' 1000 ;;
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
STATE_DIR="\${FAKE_SYSTEMCTL_STATE_DIR}"
printf '%s\\n' "$*" >> "\${FAKE_SYSTEMCTL_LOG}"

# shift off leading --user
if [ "\${1:-}" = "--user" ]; then shift; fi
cmd="\${1:-}"
shift || true

unit=""
for arg in "$@"; do
  case "$arg" in
    --*) ;;
    *) unit="$arg" ;;
  esac
done

case "$cmd" in
  daemon-reload) exit 0 ;;
  is-enabled)
    [ -f "$STATE_DIR/\${unit}.enabled" ] && { echo enabled; exit 0; }
    echo disabled; exit 1
    ;;
  is-active)
    [ -f "$STATE_DIR/\${unit}.active" ] && { echo active; exit 0; }
    echo inactive; exit 1
    ;;
  enable)
    if [ -f "$STATE_DIR/FAIL_ENABLE_\${unit}" ]; then exit 1; fi
    touch "$STATE_DIR/\${unit}.enabled"
    touch "$STATE_DIR/\${unit}.active"
    exit 0
    ;;
  disable)
    rm -f "$STATE_DIR/\${unit}.enabled" "$STATE_DIR/\${unit}.active"
    exit 0
    ;;
  start) touch "$STATE_DIR/\${unit}.active"; exit 0 ;;
  stop) rm -f "$STATE_DIR/\${unit}.active"; exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );

  if (legacyInstalled) {
    await writeFile(path.join(home, '.config', 'systemd', 'user', LEGACY_TIMER), 'placeholder legacy unit\n');
    await writeFile(path.join(stateDir, `${LEGACY_TIMER}.enabled`), '');
    await writeFile(path.join(stateDir, `${LEGACY_TIMER}.active`), '');
  }

  const registryPath = path.join(root, 'registry.json');
  await writeFile(registryPath, JSON.stringify({ schemaVersion: 1, projects: [] }));

  return {
    root,
    home,
    registryPath,
    unitDir: path.join(home, '.config', 'systemd', 'user'),
    envFile: path.join(home, '.config', 'agent-runner', 'implementation-recurrence.env'),
    stateDir,
    logPath,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      HOME: home,
      FAKE_SYSTEMCTL_STATE_DIR: stateDir,
      FAKE_SYSTEMCTL_LOG: logPath,
    },
  };
}

function runInstaller(harness, args = []) {
  return spawnSync('bash', [installer, '--agent-runner-home', repoRoot, ...args], {
    cwd: repoRoot,
    env: harness.env,
    encoding: 'utf8',
  });
}

async function readLog(harness) {
  try {
    return await readFile(harness.logPath, 'utf8');
  } catch {
    return '';
  }
}

test('installer shell syntax is valid', () => {
  const result = spawnSync('bash', ['-n', installer], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('installing without an action flag only copies unit files and reloads the daemon: it never enables, starts, disables or stops any unit', async () => {
  const harness = await createHarness();
  const result = runInstaller(harness, ['--project-registry', harness.registryPath]);
  assert.equal(result.status, 0, result.stderr);

  const serviceContents = await readFile(path.join(harness.unitDir, 'agent-runner-implementation.service'), 'utf8');
  assert.match(serviceContents, /run-implementation-recurrence\.sh/);
  const timerContents = await readFile(path.join(harness.unitDir, GENERIC_TIMER), 'utf8');
  assert.match(timerContents, /Unit=agent-runner-implementation\.service/);
  const envContents = await readFile(harness.envFile, 'utf8');
  assert.match(envContents, new RegExp(`^AGENT_RUNNER_HOME=${repoRoot}$`, 'm'));
  assert.match(envContents, new RegExp(`^AGENT_RUNNER_PROJECT_REGISTRY=${harness.registryPath}$`, 'm'));

  const log = await readLog(harness);
  assert.match(log, /daemon-reload/);
  assert.doesNotMatch(log, /\benable\b/);
  assert.doesNotMatch(log, /\bdisable\b/);
  assert.doesNotMatch(log, /\bstart\b/);
  assert.doesNotMatch(log, /\bstop\b/);
});

test('--dry-run changes no file and issues no systemctl call at all', async () => {
  const harness = await createHarness({ legacyInstalled: true });
  const result = runInstaller(harness, ['--project-registry', harness.registryPath, '--migrate-from-modelspend-only', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);

  await assert.rejects(readFile(path.join(harness.unitDir, 'agent-runner-implementation.service'), 'utf8'), { code: 'ENOENT' });
  const log = await readLog(harness);
  assert.equal(log, '');
});

test('--enable refuses when the legacy ModelSpend-only timer is still enabled or active, so both can never be simultaneous live authorities', async () => {
  const harness = await createHarness({ legacyInstalled: true });
  const result = runInstaller(harness, ['--project-registry', harness.registryPath, '--enable']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still enabled or active/);

  const log = await readLog(harness);
  assert.doesNotMatch(log, /enable --now agent-runner-implementation\.timer/);
});

test('--enable succeeds and activates the generic timer when no legacy timer is installed', async () => {
  const harness = await createHarness({ legacyInstalled: false });
  const result = runInstaller(harness, ['--project-registry', harness.registryPath, '--enable']);
  assert.equal(result.status, 0, result.stderr);

  const log = await readLog(harness);
  assert.match(log, new RegExp(`enable --now ${GENERIC_TIMER}`));
});

test('--migrate-from-modelspend-only atomically disables the legacy timer and enables the generic timer, and both are never simultaneously live', async () => {
  const harness = await createHarness({ legacyInstalled: true });
  const result = runInstaller(harness, ['--project-registry', harness.registryPath, '--migrate-from-modelspend-only']);
  assert.equal(result.status, 0, result.stderr);

  const log = await readLog(harness);
  const disableIndex = log.indexOf(`disable --now ${LEGACY_TIMER}`);
  const enableIndex = log.indexOf(`enable --now ${GENERIC_TIMER}`);
  assert.notEqual(disableIndex, -1);
  assert.notEqual(enableIndex, -1);
  assert.ok(disableIndex < enableIndex, 'legacy timer must be disabled before the generic timer is enabled');

  assert.match(result.stdout, new RegExp(`generic_timer_enabled=enabled`));
  assert.match(result.stdout, new RegExp(`legacy_timer_enabled=disabled`));
});

test('--rollback-to-modelspend-only atomically disables the generic timer and re-enables the legacy timer', async () => {
  const harness = await createHarness({ legacyInstalled: true });
  const migrateResult = runInstaller(harness, ['--project-registry', harness.registryPath, '--migrate-from-modelspend-only']);
  assert.equal(migrateResult.status, 0, migrateResult.stderr);

  const rollbackResult = runInstaller(harness, ['--rollback-to-modelspend-only']);
  assert.equal(rollbackResult.status, 0, rollbackResult.stderr);

  const log = await readLog(harness);
  const disableIndex = log.lastIndexOf(`disable --now ${GENERIC_TIMER}`);
  const enableIndex = log.lastIndexOf(`enable --now ${LEGACY_TIMER}`);
  assert.notEqual(disableIndex, -1);
  assert.notEqual(enableIndex, -1);
  assert.ok(disableIndex < enableIndex, 'generic timer must be disabled before the legacy timer is re-enabled');

  assert.match(rollbackResult.stdout, /legacy_timer_enabled=enabled/);
});

test('--rollback-to-modelspend-only fails closed when the legacy unit was never installed', async () => {
  const harness = await createHarness({ legacyInstalled: false });
  const result = runInstaller(harness, ['--rollback-to-modelspend-only']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nothing to roll back to/);
});

test('at most one of --enable / --migrate-from-modelspend-only / --rollback-to-modelspend-only may be given', async () => {
  const harness = await createHarness();
  const result = runInstaller(harness, ['--project-registry', harness.registryPath, '--enable', '--migrate-from-modelspend-only']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only one of/);
});

test('installing/migrating never adds a second live scheduling authority beyond the one selected timer', async () => {
  const harness = await createHarness({ legacyInstalled: true });
  const result = runInstaller(harness, ['--project-registry', harness.registryPath, '--migrate-from-modelspend-only']);
  assert.equal(result.status, 0, result.stderr);

  const legacyActive = await readFile(path.join(harness.stateDir, `${LEGACY_TIMER}.active`), 'utf8').catch(() => null);
  const genericActive = await readFile(path.join(harness.stateDir, `${GENERIC_TIMER}.active`), 'utf8').catch(() => null);
  assert.equal(legacyActive, null);
  assert.notEqual(genericActive, null);
});
