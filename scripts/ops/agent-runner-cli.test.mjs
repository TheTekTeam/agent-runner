import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main, USAGE_ERROR_EXIT_CODE, usageText } from './agent-runner-cli.mjs';

function memoryIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
    },
    read: () => ({ stdout, stderr }),
  };
}

test('no command or --help prints usage and exits 0', async () => {
  const output = memoryIo();
  const code = await main([], {}, output.io);
  assert.equal(code, 0);
  assert.equal(output.read().stdout, usageText());

  const output2 = memoryIo();
  const code2 = await main(['--help'], {}, output2.io);
  assert.equal(code2, 0);
  assert.equal(output2.read().stdout, usageText());
});

test('unknown command is a closed usage error, exit 2', async () => {
  const output = memoryIo();
  const code = await main(['bogus'], {}, output.io);
  assert.equal(code, USAGE_ERROR_EXIT_CODE);
  assert.deepEqual(JSON.parse(output.read().stderr), { ok: false, reason: 'Unknown command: bogus' });
});

test('queue with no or unknown subcommand is a closed usage error, exit 2', async () => {
  const output = memoryIo();
  assert.equal(await main(['queue'], {}, output.io), USAGE_ERROR_EXIT_CODE);
  assert.deepEqual(JSON.parse(output.read().stderr), { ok: false, reason: 'queue subcommand is required' });

  const output2 = memoryIo();
  assert.equal(await main(['queue', 'bogus'], {}, output2.io), USAGE_ERROR_EXIT_CODE);
  assert.deepEqual(JSON.parse(output2.read().stderr), { ok: false, reason: 'Unknown queue subcommand: bogus' });
});

test('doctor dispatches to the doctor module with the remaining argv/env/io', async () => {
  const output = memoryIo();
  let received = null;
  const doctorMain = async (argv, env, io) => { received = { argv, env, io }; io.stdout.write('doctor-ran'); return 0; };
  const code = await main(['doctor', '--project', 'modelspend'], { X: '1' }, output.io, { doctorMain });
  assert.equal(code, 0);
  assert.deepEqual(received.argv, ['--project', 'modelspend']);
  assert.deepEqual(received.env, { X: '1' });
  assert.equal(output.read().stdout, 'doctor-ran');
});

test('status dispatches to the status module', async () => {
  const output = memoryIo();
  let received = null;
  const statusMain = async (argv) => { received = argv; return 0; };
  const code = await main(['status', '--json'], {}, output.io, { statusMain });
  assert.equal(code, 0);
  assert.deepEqual(received, ['--json']);
});

test('queue explain dispatches to the explain module', async () => {
  const output = memoryIo();
  let received = null;
  const explainMain = async (argv) => { received = argv; return 0; };
  const code = await main(['queue', 'explain', '--project', 'modelspend'], {}, output.io, { explainMain });
  assert.equal(code, 0);
  assert.deepEqual(received, ['--project', 'modelspend']);
});

test('queue repair dispatches to the repair module with dependencies, returning its exit code verbatim', async () => {
  const output = memoryIo();
  let received = null;
  const repairMain = async (argv, env, dependencies) => { received = { argv, env, dependencies }; return 2; };
  const code = await main(
    ['queue', 'repair', '--incident', '2026-07-20-queue-drain', '--dry-run'],
    {},
    output.io,
    { repairMain, repairDependencies: { openStore: 'fake' } },
  );
  assert.equal(code, 2);
  assert.deepEqual(received.argv, ['--incident', '2026-07-20-queue-drain', '--dry-run']);
  assert.deepEqual(received.dependencies, { openStore: 'fake' });
});

test('queue repair converts a thrown parse error into a closed usage error, never the raw exception text', async () => {
  const output = memoryIo();
  const repairMain = async () => { throw new Error('unsupported incident: raw-secret-detail-should-not-leak'); };
  const code = await main(['queue', 'repair', '--incident', 'bogus'], {}, output.io, { repairMain });
  assert.equal(code, USAGE_ERROR_EXIT_CODE);
  const stderr = output.read().stderr;
  assert.equal(stderr.includes('raw-secret-detail-should-not-leak'), false);
  assert.deepEqual(JSON.parse(stderr), { ok: false, reason: 'queue-repair-invocation-error' });
});

test('queue repair preserves the underlying module\'s explicit --execute flag verbatim', async () => {
  const output = memoryIo();
  let received = null;
  const repairMain = async (argv) => { received = argv; return 0; };
  const code = await main(
    ['queue', 'repair', '--incident', '2026-07-20-queue-drain', '--execute'],
    {},
    output.io,
    { repairMain },
  );
  assert.equal(code, 0);
  assert.deepEqual(received, ['--incident', '2026-07-20-queue-drain', '--execute']);
});

test('the real queue repair module stays dry-run by default when dispatched end to end, and never issues a mutating gh subcommand', async () => {
  // agent-runner-queue-repair.mjs's main() writes via the real console, not
  // an injectable io -- capture it for the duration of this one call only.
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-cli-repair-'));
  const ghCalls = [];
  const ghRunner = (jsonArgs) => {
    ghCalls.push(jsonArgs);
    if (jsonArgs[0] === 'pr' && jsonArgs[1] === 'list') return '[]';
    if (jsonArgs[0] === 'issue' && jsonArgs[1] === 'view') return '{}';
    throw new Error(`unexpected gh invocation in test: ${jsonArgs.join(' ')}`);
  };
  const originalLog = console.log;
  let captured = '';
  console.log = (text) => { captured += text; };
  let code;
  try {
    code = await main(['queue', 'repair', '--incident', '2026-07-20-queue-drain'], {
      CLAUDE_RUNNER_STATE_DB: join(dir, 'missing-state.sqlite'),
      GITHUB_REPOSITORY: 'TheTekTeam/modelspend',
    }, memoryIo().io, { repairDependencies: { ghRunner } });
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
  const report = JSON.parse(captured);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.issueMutation, false);
  assert.equal(report.stateMutation, false);
  assert.equal(typeof code, 'number');

  // The underlying canonical repair implementation always inspects the
  // repo-wide open-PR list while building its restoration plan, even with
  // zero classified incident rows -- so this proves ghRunner was actually
  // exercised, not merely unreached, and that every call it made was a
  // read-only gh subcommand.
  assert.ok(ghCalls.length > 0);
  for (const call of ghCalls) {
    assert.notEqual(call[1], 'edit');
    assert.notEqual(call[1], 'comment');
    assert.notEqual(call[1], 'close');
    assert.notEqual(call[1], 'create');
    assert.equal(call.includes('-X'), false);
  }
});

test('run() fails closed on an unreadable --config file for doctor/status/queue explain, instead of an unhandled rejection with a raw stack trace and path', async () => {
  for (const command of [['doctor'], ['status'], ['queue', 'explain']]) {
    const output = memoryIo();
    const code = await main([...command, '--config', '/nonexistent-agent-runner-cli-config.json'], {}, output.io);
    assert.equal(code, USAGE_ERROR_EXIT_CODE, command.join(' '));
    assert.deepEqual(JSON.parse(output.read().stderr), { ok: false, reason: 'config-load-failed' }, command.join(' '));
  }
});

test('subprocess: bin/agent-runner --help exits 0 with no stack trace', () => {
  const result = execFileSync(process.execPath, [new URL('../../bin/agent-runner', import.meta.url).pathname, '--help'], { encoding: 'utf8' });
  assert.match(result, /Usage: agent-runner/);
});

test('subprocess: bin/agent-runner with an unknown command exits 2 and prints only a closed JSON reason', () => {
  let threw = false;
  try {
    execFileSync(process.execPath, [new URL('../../bin/agent-runner', import.meta.url).pathname, 'bogus'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    threw = true;
    assert.equal(error.status, 2);
    assert.deepEqual(JSON.parse(error.stderr.split('\n')[0]), { ok: false, reason: 'Unknown command: bogus' });
  }
  assert.equal(threw, true);
});
