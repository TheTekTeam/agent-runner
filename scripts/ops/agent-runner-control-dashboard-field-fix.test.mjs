import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const INSTALLER = path.join(ROOT, 'scripts/install-control-dashboard.sh');
const UNIT_SOURCE = path.join(ROOT, 'systemd/user/agent-runner-control.service.in');

function makeFixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'ar174-field-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const checkout = path.join(base, 'checkout');
  const home = path.join(base, 'home');
  const fakeBin = path.join(base, 'bin');
  const state = path.join(base, 'state');
  const server = path.join(checkout, 'scripts/ops/agent-runner-control-server.mjs');
  mkdirSync(path.dirname(server), { recursive: true });
  mkdirSync(path.join(checkout, 'systemd/user'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(home, { recursive: true });

  copyFileSync(INSTALLER, path.join(checkout, 'scripts/install-control-dashboard.sh'));
  copyFileSync(UNIT_SOURCE, path.join(checkout, 'systemd/user/agent-runner-control.service.in'));
  writeFileSync(server, '#!/usr/bin/env node\n');

  const approvedNode = path.join(base, 'approved-node');
  writeFileSync(approvedNode, '#!/usr/bin/env bash\nprintf "22.23.2"\n');
  chmodSync(approvedNode, 0o755);
  const installerPath = path.join(checkout, 'scripts/install-control-dashboard.sh');
  writeFileSync(
    installerPath,
    readFileSync(installerPath, 'utf8').replace("NODE_BIN='/usr/bin/node'", `NODE_BIN='${approvedNode}'`),
  );
  chmodSync(installerPath, 0o755);

  const git = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'rev-parse --show-toplevel'*) printf '%s\\n' "$FAKE_CHECKOUT" ;;
  *'remote get-url origin'*) printf '%s\\n' 'git@github.com:TheTekTeam/agent-runner.git' ;;
  *) exit 1 ;;
esac
`;

  const systemctl = `#!/usr/bin/env bash
set -euo pipefail
cmd=''
for arg in "$@"; do
  case "$arg" in --user|--quiet|--no-pager) ;; *) [[ -n "$cmd" ]] || cmd=$arg ;; esac
done
unit="$HOME/.config/systemd/user/agent-runner-control.service"
wants="$HOME/.config/systemd/user/default.target.wants/agent-runner-control.service"
case "$cmd" in
  is-enabled)
    if [[ -f "$FAKE_STATE/enabled" ]]; then echo enabled; exit 0; fi
    if [[ ! -f "$unit" ]]; then echo not-found; exit 4; fi
    echo disabled; exit 1 ;;
  is-active)
    if [[ -f "$FAKE_STATE/activating-after-stop" ]]; then echo activating; exit 3; fi
    if [[ -f "$FAKE_STATE/active" ]]; then
      count=0
      [[ ! -f "$FAKE_STATE/is-active-count" ]] || count=$(cat "$FAKE_STATE/is-active-count")
      count=$((count + 1))
      printf '%s' "$count" >"$FAKE_STATE/is-active-count"
      activating_count=${FAKE_STARTUP_ACTIVATING_COUNT:-0}
      if (( count <= activating_count )); then echo activating; exit 3; fi
      echo active; exit 0
    fi
    echo inactive; exit 3 ;;
  enable)
    touch "$FAKE_STATE/enabled"
    mkdir -p "$(dirname "$wants")"
    ln -sfn "$unit" "$wants" ;;
  disable)
    rm -f "$FAKE_STATE/enabled" "$wants" ;;
  start|restart)
    rm -f "$FAKE_STATE/activating-after-stop" "$FAKE_STATE/is-active-count"
    touch "$FAKE_STATE/active" ;;
  stop)
    rm -f "$FAKE_STATE/active"
    if [[ ${FAKE_STOP_STAYS_ACTIVATING:-0} == 1 ]]; then touch "$FAKE_STATE/activating-after-stop"; else rm -f "$FAKE_STATE/activating-after-stop"; fi ;;
  daemon-reload) : ;;
  status) [[ -f "$FAKE_STATE/active" ]] ;;
esac
`;

  const ss = `#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f "$FAKE_STATE/ss-count" ]] || count=$(cat "$FAKE_STATE/ss-count")
count=$((count + 1))
printf '%s' "$count" >"$FAKE_STATE/ss-count"
if (( count == 1 )) && [[ \${FAKE_PREFLIGHT_COLLISION:-0} == 1 ]]; then
  printf 'LISTEN 0 511 127.0.0.1:8789 0.0.0.0:*\\n'
  exit 0
fi
[[ -f "$FAKE_STATE/active" ]] || exit 0
[[ \${FAKE_ALWAYS_NO_LISTENER:-0} != 1 ]] || exit 0
# Call 1 is preflight. Call 2 deliberately reproduces Dell's immediate
# post-Type=simple activation window with no listener yet.
(( count >= 3 )) || exit 0
printf 'LISTEN 0 511 127.0.0.1:8789 0.0.0.0:*\\n'
`;

  const curl = `#!/usr/bin/env bash
set -euo pipefail
headers=''; body=''
while (($#)); do
  case "$1" in
    --dump-header) headers=$2; shift 2 ;;
    --output) body=$2; shift 2 ;;
    --write-out) shift 2 ;;
    *) shift ;;
  esac
done
printf 'HTTP/1.1 200 OK\\r\\nContent-Security-Policy: default-src self\\r\\n\\r\\n' >"$headers"
printf '<title>Agent Runner — Operations</title>\\n' >"$body"
printf '200'
`;

  const analyze = '#!/usr/bin/env bash\nexit 0\n';
  const sleep = '#!/usr/bin/env bash\nexit 0\n';
  for (const [name, source] of [
    ['git', git], ['systemctl', systemctl], ['ss', ss], ['curl', curl],
    ['systemd-analyze', analyze], ['sleep', sleep],
  ]) {
    const target = path.join(fakeBin, name);
    writeFileSync(target, source);
    chmodSync(target, 0o755);
  }

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_CHECKOUT: checkout,
    FAKE_STATE: state,
  };
  const run = (extraEnv = {}) => spawnSync('bash', [installerPath, 'install'], {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
    timeout: 10_000,
  });
  return {
    home,
    run,
    unit: path.join(home, '.config/systemd/user/agent-runner-control.service'),
    wants: path.join(home, '.config/systemd/user/default.target.wants/agent-runner-control.service'),
  };
}

test('fresh install waits through the Type=simple startup window before requiring the exact listener', (t) => {
  if (process.platform !== 'linux') return t.skip('systemd installer contract is Linux-only');
  if (process.getuid?.() === 0) return t.skip('installer correctly refuses root');
  const fixture = makeFixture(t);
  const result = fixture.run();
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /INSTALLED: agent-runner-control\.service is enabled and healthy/);
  assert.equal(existsSync(fixture.unit), true);
  assert.equal(existsSync(fixture.wants), true);
});

test('fresh install tolerates a bounded activating state before becoming active', (t) => {
  if (process.platform !== 'linux') return t.skip('systemd installer contract is Linux-only');
  if (process.getuid?.() === 0) return t.skip('installer correctly refuses root');
  const fixture = makeFixture(t);
  const result = fixture.run({ FAKE_STARTUP_ACTIVATING_COUNT: '2' });
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /INSTALLED: agent-runner-control\.service is enabled and healthy/);
  assert.equal(existsSync(fixture.unit), true);
  assert.equal(existsSync(fixture.wants), true);
});

test('fresh activation failure restores the absent state without a dangling wants link or status-4 rollback error', (t) => {
  if (process.platform !== 'linux') return t.skip('systemd installer contract is Linux-only');
  if (process.getuid?.() === 0) return t.skip('installer correctly refuses root');
  const fixture = makeFixture(t);
  const result = fixture.run({ FAKE_ALWAYS_NO_LISTENER: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /activation or health verification failed/);
  assert.doesNotMatch(result.stderr, /rollback could not fully restore previous service state/);
  assert.doesNotMatch(result.stderr, /could not determine whether agent-runner-control\.service is enabled/);
  assert.equal(existsSync(fixture.unit), false);
  assert.equal(existsSync(fixture.wants), false);
});

test('rollback remains fail-closed if stop leaves the service in activating state', (t) => {
  if (process.platform !== 'linux') return t.skip('systemd installer contract is Linux-only');
  if (process.getuid?.() === 0) return t.skip('installer correctly refuses root');
  const fixture = makeFixture(t);
  const result = fixture.run({ FAKE_ALWAYS_NO_LISTENER: '1', FAKE_STOP_STAYS_ACTIVATING: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback could not fully restore previous service state/);
  assert.equal(existsSync(fixture.unit), true, 'strict rollback must preserve the unit when stop state is transient');
});

test('fresh preflight collision preserves the absent state without trying to stop a nonexistent unit', (t) => {
  if (process.platform !== 'linux') return t.skip('systemd installer contract is Linux-only');
  if (process.getuid?.() === 0) return t.skip('installer correctly refuses root');
  const fixture = makeFixture(t);
  const result = fixture.run({ FAKE_PREFLIGHT_COLLISION: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /port 8789 is already in use/);
  assert.doesNotMatch(result.stderr, /rollback could not fully restore previous service state/);
  assert.equal(existsSync(fixture.unit), false);
  assert.equal(existsSync(fixture.wants), false);
});
