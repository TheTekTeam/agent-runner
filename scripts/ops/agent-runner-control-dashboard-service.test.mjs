import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONTROL_CLI_PORT,
  parseControlCliPort,
  parseControlServerCliArgs,
  RESERVED_EVENT_INGRESS_PORT,
} from './agent-runner-control-server-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const INSTALLER = path.join(ROOT, 'scripts/install-control-dashboard.sh');
const UNIT_SOURCE = path.join(ROOT, 'systemd/user/agent-runner-control.service.in');
const SERVER = path.join(ROOT, 'scripts/ops/agent-runner-control-server.mjs');

const invalidPorts = ['', '0', '+1', '-1', ' 1', '1 ', '01', '00001', '1x', '1.0', '65536', '99999', '8787'];

test('control server production CLI is fixed-loopback and uses strict port syntax', () => {
  assert.deepEqual(parseControlServerCliArgs([]), { help: false, host: '127.0.0.1', port: 8789 });
  assert.equal(DEFAULT_CONTROL_CLI_PORT, 8789);
  assert.equal(RESERVED_EVENT_INGRESS_PORT, 8787);
  assert.equal(parseControlCliPort('1'), 1);
  assert.equal(parseControlCliPort('65535'), 65535);
  assert.throws(() => parseControlCliPort('8787'), { code: 'AGENT_RUNNER_CONTROL_RESERVED_PORT' });
  assert.deepEqual(parseControlServerCliArgs(['--port', '8789']), { help: false, host: '127.0.0.1', port: 8789 });
  for (const value of invalidPorts) assert.throws(() => parseControlServerCliArgs(['--port', value]));
  assert.throws(() => parseControlServerCliArgs(['--port']));
  assert.throws(() => parseControlServerCliArgs(['--port', '8789', '--port', '8790']));
  for (const args of [['--host', '127.0.0.1'], ['--listen', '8789'], ['8789'], ['--port=8789'], ['--help', '--port', '8789']]) {
    assert.throws(() => parseControlServerCliArgs(args));
  }
  const source = readFileSync(SERVER, 'utf8');
  assert.match(source, /listenControlServer\(server, \{ host: parsed\.host, port: parsed\.port \}\)/);
  const core = readFileSync(path.join(ROOT, 'scripts/ops/agent-runner-control-server-core.mjs'), 'utf8');
  assert.match(core, /port = 0/); // direct test/programmatic API still permits ephemeral port 0
});

test('rendered service source contains required hardening, inherited jitless, exact writable paths, and no secrets', () => {
  const source = readFileSync(UNIT_SOURCE, 'utf8');
  for (const directive of [
    'NoNewPrivileges=true', 'PrivateTmp=true', 'ProtectSystem=strict', 'ProtectHome=read-only',
    'RestrictAddressFamilies=AF_UNIX AF_INET', 'LockPersonality=true', 'RestrictRealtime=true',
    'RestrictSUIDSGID=true', 'UMask=0077', 'MemoryDenyWriteExecute=true', 'TasksMax=64',
    'MemoryMax=384M', 'TimeoutStartSec=20s', 'TimeoutStopSec=15s',
    'ReadOnlyPaths=%h/.local/state/agent-runner',
    'ReadWritePaths=%h/.config/agent-runner',
    'ReadWritePaths=%h/.local/state/agent-runner/secrets',
    'ReadWritePaths=%h/.local/state/agent-runner/control-audit.jsonl',
    'Environment=NODE_OPTIONS=--jitless',
    'Environment=AGENT_RUNNER_CONFIG=%h/.config/agent-runner/modelspend.json',
    'Environment=CLAUDE_RUNNER_STATE_DB=%h/.local/state/agent-runner/modelspend/runner-state.sqlite',
    'Environment=AGENT_RUNNER_CONTROL_SCHEDULER_SERVICE=agent-runner-implementation.service',
    'Environment=AGENT_RUNNER_CONTROL_SCHEDULER_TIMER=agent-runner-implementation.timer',
  ]) assert.ok(source.includes(directive), `missing ${directive}`);
  assert.match(source, /ExecStart=@@NODE@@ --jitless @@SERVER@@ --port @@PORT@@/);
  assert.doesNotMatch(source, /AmbientCapabilities|CapabilityBoundingSet|SecureBits|EnvironmentFile/);
  const environmentLines = source.split('\n').filter((line) => line.startsWith('Environment='));
  assert.equal(environmentLines.length, 10);
  assert.equal(new Set(environmentLines).size, environmentLines.length);
  assert.doesNotMatch(source, /8787/);
  assert.doesNotMatch(source, /(password|bearer|api[_-]?key|token)=/i);
});

test('repository service template passes real systemd-analyze verification when available', { skip: process.platform !== 'linux' }, (t) => {
  const available = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  if (available.status !== 0) return t.skip('systemd-analyze unavailable');
  const dir = mkdtempSync(path.join(tmpdir(), 'ar174-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unitPath = path.join(dir, 'agent-runner-control.service');
  const rendered = readFileSync(UNIT_SOURCE, 'utf8')
    .replaceAll('@@CHECKOUT@@', ROOT)
    .replaceAll('@@SERVER@@', SERVER)
    .replaceAll('@@NODE@@', process.execPath)
    .replaceAll('@@PORT@@', '8789');
  writeFileSync(unitPath, rendered);
  let result = spawnSync('systemd-analyze', ['--user', 'verify', unitPath], { encoding: 'utf8' });
  if (result.status !== 0 && /Failed to (?:lookup RuntimeDirectory path|initialize manager)/.test(result.stderr)) {
    // CI containers may have systemd-analyze without a live user manager.
    // Still validate the unit generically so actual unit errors remain fatal.
    result = spawnSync('systemd-analyze', ['verify', unitPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    return t.skip('user systemd manager unavailable; generic unit verification passed');
  }
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
});

function makeFixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'ar174-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const checkout = path.join(base, 'checkout');
  const home = path.join(base, 'home');
  const fakeBin = path.join(base, 'bin');
  const fakeState = path.join(base, 'fake-state');
  mkdirSync(path.join(checkout, 'scripts/ops'), { recursive: true });
  mkdirSync(path.join(checkout, 'systemd/user'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(fakeState, { recursive: true });
  mkdirSync(home, { recursive: true });
  cpSync(INSTALLER, path.join(checkout, 'scripts/install-control-dashboard.sh'));
  cpSync(UNIT_SOURCE, path.join(checkout, 'systemd/user/agent-runner-control.service.in'));
  writeFileSync(path.join(checkout, 'scripts/ops/agent-runner-control-server.mjs'), '#!/usr/bin/env node\n');
  chmodSync(path.join(checkout, 'scripts/install-control-dashboard.sh'), 0o755);
  symlinkSync(process.execPath, path.join(fakeBin, 'node'));

  const log = path.join(fakeState, 'mutations.log');
  const git = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'rev-parse --show-toplevel'*) printf '%s\n' "$FAKE_CHECKOUT" ;;
  *'remote get-url origin'*) printf '%s\n' "\${FAKE_GIT_ORIGIN:-git@github.com:TheTekTeam/agent-runner.git}" ;;
  *) exit 1 ;;
esac
`;
  const systemctl = `#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\\n' "$*" >>"$FAKE_STATE/mutations.log"
cmd=''; now=0
for arg in "$@"; do
  case "$arg" in --user|--quiet|--no-pager) ;; --now) now=1 ;; *) if [[ -z "$cmd" ]]; then cmd=$arg; fi ;; esac
done
service=agent-runner-control.service
fail_on=\${FAKE_SYSTEMCTL_FAIL_ON:-}
fail_once=\${FAKE_SYSTEMCTL_FAIL_ONCE:-}
[[ "$cmd" != "$fail_on" ]] || exit 1
if [[ "$cmd" == "$fail_once" && ! -f "$FAKE_STATE/fail-once-$cmd" ]]; then touch "$FAKE_STATE/fail-once-$cmd"; exit 1; fi
case "$cmd" in
  is-enabled) if [[ -f "$FAKE_STATE/enabled" ]]; then echo enabled; else echo disabled; exit 1; fi ;;
  is-active) if [[ -f "$FAKE_STATE/active" ]]; then echo active; else echo inactive; exit 3; fi ;;
  enable) touch "$FAKE_STATE/enabled"; if (( now )); then touch "$FAKE_STATE/active"; fi ;;
  disable) rm -f "$FAKE_STATE/enabled"; if (( now )); then rm -f "$FAKE_STATE/active"; fi ;;
  start|restart) touch "$FAKE_STATE/active"; n=0; [[ -f "$FAKE_STATE/pid" ]] && n=$(cat "$FAKE_STATE/pid"); echo $((n+1)) >"$FAKE_STATE/pid" ;;
  stop) rm -f "$FAKE_STATE/active" ;;
  status) [[ -f "$FAKE_STATE/active" ]] ;;
  daemon-reload) : ;;
esac
`;
  const ss = `#!/usr/bin/env bash
set -euo pipefail
[[ \${FAKE_SS_FAIL:-0} != 1 ]] || exit 1
port=$(printf '%s ' "$@" | sed -n 's/.*sport = :\\([0-9][0-9]*\\).*/\\1/p')
mode=\${FAKE_LISTENER_MODE:-auto}
if [[ "$mode" == collision ]]; then printf 'LISTEN 0 128 0.0.0.0:%s 0.0.0.0:*\\n' "$port"; exit 0; fi
if [[ "$mode" == ipv6 ]]; then printf 'LISTEN 0 128 [::1]:%s [::]:*\\n' "$port"; exit 0; fi
if [[ "$mode" == duplicate ]]; then printf 'LISTEN 0 128 127.0.0.1:%s 0.0.0.0:*\\nLISTEN 0 128 127.0.0.1:%s 0.0.0.0:*\\n' "$port" "$port"; exit 0; fi
if [[ -f "$FAKE_STATE/active" ]]; then printf 'LISTEN 0 128 127.0.0.1:%s 0.0.0.0:*\\n' "$port"; fi
`;
const curl = `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\\n' "$*" >>"$FAKE_STATE/mutations.log"
[[ \${FAKE_CURL_FAIL:-0} != 1 ]]
if [[ \${FAKE_CURL_BAD:-0} == 1 ]]; then printf 'HTTP/1.1 200 OK\r\n\r\nwrong service\n'; exit 0; fi
printf 'HTTP/1.1 200 OK\r\nContent-Security-Policy: default-src '\''self'\''\r\n\r\n<title>Agent Runner — Operations</title>\n'
`;
  const analyze = `#!/usr/bin/env bash
set -euo pipefail
printf 'systemd-analyze %s\\n' "$*" >>"$FAKE_STATE/mutations.log"
[[ \${FAKE_ANALYZE_FAIL:-0} != 1 ]]
`;
  for (const [name, content] of [['git', git], ['systemctl', systemctl], ['ss', ss], ['curl', curl], ['systemd-analyze', analyze]]) {
    writeFileSync(path.join(fakeBin, name), content);
    chmodSync(path.join(fakeBin, name), 0o755);
  }

  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FAKE_STATE: fakeState, FAKE_CHECKOUT: checkout, PATH: `${fakeBin}:${process.env.PATH}` };
  const run = (args, extraEnv = {}) => spawnSync('bash', [path.join(checkout, 'scripts/install-control-dashboard.sh'), ...args], {
    env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10_000,
  });
  const unit = path.join(home, '.config/systemd/user/agent-runner-control.service');
  return { base, checkout, home, fakeState, log, env, run, unit };
}

function assertOk(result) {
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
}

function seedPreservedState(f) {
  const paths = [
    '.config/agent-runner/agent-settings.json',
    '.local/state/agent-runner/control-operator.json',
    '.local/state/agent-runner/secrets/provider.ref',
    '.local/state/agent-runner/control-audit.jsonl',
    '.local/state/agent-runner/modelspend/runner-state.sqlite',
    '.local/state/agent-runner/implementation-recurrence.lock',
    '.local/state/agent-runner/source-activation/state.json',
  ];
  const before = new Map();
  for (const relative of paths) {
    const full = path.join(f.home, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    const value = `sentinel:${relative}`;
    writeFileSync(full, value);
    before.set(full, value);
  }
  return () => {
    for (const [full, value] of before) assert.equal(readFileSync(full, 'utf8'), value, `mutated ${full}`);
  };
}

test('installer refuses root before mutation', { skip: process.platform !== 'linux' }, (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) {
    const result = f.run(['install']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing .* as root/);
    assert.equal(existsSync(f.unit), false);
    return;
  }
  const sudo = spawnSync('sudo', ['-n', 'true']);
  if (sudo.status !== 0) return t.skip('passwordless sudo unavailable for root-refusal probe');
  const result = spawnSync('sudo', ['-n', 'env', `HOME=${f.home}`, `PATH=${f.env.PATH}`, `FAKE_STATE=${f.fakeState}`, 'bash', path.join(f.checkout, 'scripts/install-control-dashboard.sh'), 'install'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing .* as root/);
  assert.equal(existsSync(f.unit), false);
});

test('installer rejects malformed, zero, signed, whitespace, suffixed, leading-zero, out-of-range, and reserved ports', (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root; root refusal is covered separately');
  for (const port of invalidPorts) assert.notEqual(f.run(['status', '--port', port]).status, 0, port);
  assert.notEqual(f.run(['status', '--port']).status, 0);
  assert.notEqual(f.run(['status', '--host', '127.0.0.1']).status, 0);
  assert.notEqual(f.run(['bogus']).status, 0);
});

test('installer rejects a copied checkout with a non-canonical Git origin', (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  const result = f.run(['install'], { FAKE_GIT_ORIGIN: 'git@example.invalid:other/repository.git' });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.unit), false);
});

test('fresh install provisions only required writable control paths and never an operator credential', (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  assertOk(f.run(['install']));
  assert.equal(existsSync(path.join(f.home, '.config/agent-runner')), true);
  assert.equal(existsSync(path.join(f.home, '.local/state/agent-runner/secrets')), true);
  assert.equal(existsSync(path.join(f.home, '.local/state/agent-runner/control-audit.jsonl')), true);
  assert.equal(existsSync(path.join(f.home, '.local/state/agent-runner/control-operator.json')), false);
});

test('install is idempotent, lifecycle is bounded, and disable/remove/reinstall preserve runner state', (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  const assertPreserved = seedPreservedState(f);
  assertOk(f.run(['install']));
  assert.equal(readFileSync(path.join(f.fakeState, 'pid'), 'utf8').trim(), '1');
  const rendered = readFileSync(f.unit, 'utf8');
  assert.match(rendered, /--jitless .*agent-runner-control-server\.mjs --port 8789/);
  assert.match(rendered, /^Environment=NODE_OPTIONS=--jitless$/m);
  assert.doesNotMatch(rendered, /8787|EnvironmentFile|password|token=/i);
  assertOk(f.run(['install']));
  assert.equal(readFileSync(path.join(f.fakeState, 'pid'), 'utf8').trim(), '1', 'unchanged install restarted process');
  assertOk(f.run(['verify']));
  assertOk(f.run(['status']));
  assertOk(f.run(['disable']));
  assertOk(f.run(['enable']));
  assertOk(f.run(['remove']));
  assert.equal(existsSync(f.unit), false);
  assertPreserved();
  assertOk(f.run(['install']));
  assertPreserved();
  const mutations = readFileSync(f.log, 'utf8');
  for (const forbidden of [
    'agent-runner-implementation.service', 'agent-runner-implementation.timer', 'agent-runner-modelspend.',
    'event-ingress', 'event-polling', '8787', 'runner-state.sqlite', 'implementation.lock', 'source-activation', 'github',
  ]) assert.equal(mutations.includes(forbidden), false, `forbidden mutation evidence: ${forbidden}`);
});

test('changed upgrade validates first and rolls back prior unit plus enabled/active state after activation, restart, or health failure', (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  assertOk(f.run(['install']));
  const oldUnit = readFileSync(f.unit, 'utf8') + '# old-version-sentinel\n';
  writeFileSync(f.unit, oldUnit);

  const failEnable = f.run(['install'], { FAKE_SYSTEMCTL_FAIL_ONCE: 'enable' });
  assert.notEqual(failEnable.status, 0);
  assert.equal(readFileSync(f.unit, 'utf8'), oldUnit);
  assert.equal(existsSync(path.join(f.fakeState, 'enabled')), true);
  assert.equal(existsSync(path.join(f.fakeState, 'active')), true);

  const failRestart = f.run(['install'], { FAKE_SYSTEMCTL_FAIL_ONCE: 'restart' });
  assert.notEqual(failRestart.status, 0);
  assert.equal(readFileSync(f.unit, 'utf8'), oldUnit);
  assert.equal(existsSync(path.join(f.fakeState, 'enabled')), true);
  assert.equal(existsSync(path.join(f.fakeState, 'active')), true);

  const failHealth = f.run(['install'], { FAKE_CURL_FAIL: '1' });
  assert.notEqual(failHealth.status, 0);
  assert.equal(readFileSync(f.unit, 'utf8'), oldUnit);
  assert.equal(existsSync(path.join(f.fakeState, 'enabled')), true);
  assert.equal(existsSync(path.join(f.fakeState, 'active')), true);

  assertOk(f.run(['install']));
  assert.doesNotMatch(readFileSync(f.unit, 'utf8'), /old-version-sentinel/);
});

test('activation refuses collisions and verify rejects wildcard, IPv6 and duplicate listeners', (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  assertOk(f.run(['install']));
  assertOk(f.run(['disable']));
  assert.notEqual(f.run(['enable'], { FAKE_SS_FAIL: '1' }).status, 0);
  assert.equal(existsSync(path.join(f.fakeState, 'active')), false);
  assert.notEqual(f.run(['enable'], { FAKE_LISTENER_MODE: 'collision' }).status, 0);
  assert.equal(existsSync(path.join(f.fakeState, 'active')), false);
  assertOk(f.run(['enable']));
  for (const mode of ['collision', 'ipv6', 'duplicate']) {
    const result = f.run(['verify'], { FAKE_LISTENER_MODE: mode });
    assert.notEqual(result.status, 0, mode);
  }
  assert.notEqual(f.run(['verify'], { FAKE_CURL_BAD: '1' }).status, 0);
});

test('unchanged install and enable restore prior disabled/inactive state after health failure', (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  assertOk(f.run(['install']));
  assertOk(f.run(['disable']));
  assert.notEqual(f.run(['install'], { FAKE_CURL_FAIL: '1' }).status, 0);
  assert.equal(existsSync(path.join(f.fakeState, 'active')), false);
  assert.equal(existsSync(path.join(f.fakeState, 'enabled')), false);
  assert.notEqual(f.run(['enable'], { FAKE_CURL_FAIL: '1' }).status, 0);
  assert.equal(existsSync(path.join(f.fakeState, 'active')), false);
  assert.equal(existsSync(path.join(f.fakeState, 'enabled')), false);
});

test('failed fresh-install rollback preserves the unit when the started process cannot be stopped', (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  const result = f.run(['install'], { FAKE_CURL_FAIL: '1', FAKE_SYSTEMCTL_FAIL_ON: 'stop' });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.unit), true);
  assert.equal(existsSync(path.join(f.fakeState, 'active')), true);
});

test('unit target path refuses symlinked directories and unit files', (t) => {
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  for (const target of ['directory', 'unit']) {
    const f = makeFixture(t);
    const outside = path.join(f.base, `outside-${target}`);
    mkdirSync(outside, { recursive: true });
    if (target === 'directory') {
      mkdirSync(path.join(f.home, '.config'), { recursive: true });
      symlinkSync(outside, path.join(f.home, '.config/systemd'));
    } else {
      mkdirSync(path.dirname(f.unit), { recursive: true });
      symlinkSync(path.join(outside, 'redirected.service'), f.unit);
    }
    assert.notEqual(f.run(['install']).status, 0, target);
    assert.equal(existsSync(path.join(outside, 'redirected.service')), false, target);
  }
});

test('disable/remove fail closed and preserve the unit when stop fails', (t) => {
  const f = makeFixture(t);
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  assertOk(f.run(['install']));
  const unitBefore = readFileSync(f.unit, 'utf8');
  const failedRemove = f.run(['remove'], { FAKE_SYSTEMCTL_FAIL_ONCE: 'stop' });
  assert.notEqual(failedRemove.status, 0);
  assert.equal(readFileSync(f.unit, 'utf8'), unitBefore);
  assert.equal(existsSync(path.join(f.fakeState, 'active')), true);
  assert.equal(existsSync(path.join(f.fakeState, 'enabled')), true);
});

test('disable/remove fail closed when active or enabled state is indeterminate', (t) => {
  if (process.getuid?.() === 0) return t.skip('lifecycle fixture requires non-root');
  for (const probe of ['is-active', 'is-enabled']) {
    const f = makeFixture(t);
    assertOk(f.run(['install']));
    const unitBefore = readFileSync(f.unit, 'utf8');
    const result = f.run(['remove'], { FAKE_SYSTEMCTL_FAIL_ON: probe });
    assert.notEqual(result.status, 0, probe);
    assert.equal(readFileSync(f.unit, 'utf8'), unitBefore, `${probe} error removed the unit`);
  }
});
