import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = new URL('../install-agent-runner-fleet-runtime.sh', import.meta.url);
const SAFE_TEST_PATH = '/usr/bin:/bin';

function run(args) {
  return spawnSync('/usr/bin/bash', [SCRIPT.pathname, ...args], {
    encoding: 'utf8',
    env: {
      PATH: SAFE_TEST_PATH,
      HOME: process.env.HOME || '/tmp',
    },
  });
}

test('fleet runtime installer documents the bounded Claude-only contract', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude-code-cli/);
  assert.match(result.stdout, /Ubuntu\/Debian/);
  assert.match(result.stdout, /signed stable apt repository/);
  assert.match(result.stdout, /does not perform\s+provider login\/authentication/i);
});

test('fleet runtime installer dry-run performs no package, auth, scheduler or routing mutation', () => {
  const result = run(['--adapter', 'claude-code-cli', '--worker-only', '--dry-run']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /worker-only mode/);
  assert.match(result.stdout, /--dry-run: would .*Anthropic signing key/);
  assert.match(result.stdout, /31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE/);
  assert.match(result.stdout, /stable repository https:\/\/downloads\.claude\.ai\/claude-code\/apt\/stable/);
  assert.match(result.stdout, /install package claude-code through apt/);
});

test('fleet runtime installer refuses foundation-only adapters instead of guessing install commands', () => {
  for (const adapterId of ['codex-cli', 'grok-cli', 'ollama-agent']) {
    const result = run(['--adapter', adapterId, '--dry-run']);
    assert.notEqual(result.status, 0, adapterId);
    assert.match(result.stderr, /no reviewed live fleet installation mechanism/);
  }
});

test('fleet runtime installer source pins signed Anthropic apt inputs and excludes forbidden authority/auth paths', async () => {
  const source = await readFile(SCRIPT, 'utf8');

  assert.match(source, /https:\/\/downloads\.claude\.ai\/keys\/claude-code\.asc/);
  assert.match(source, /https:\/\/downloads\.claude\.ai\/claude-code\/apt\/stable/);
  assert.match(source, /31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE/);
  assert.match(source, /sudo apt-get install -y claude-code/);
  assert.match(source, /gpg --show-keys --with-colons/);

  assert.doesNotMatch(source, /curl[^\n]*\|[^\n]*bash/);
  assert.doesNotMatch(source, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(source, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.doesNotMatch(source, /systemctl[^\n]*(enable|start|restart)/);
  assert.doesNotMatch(source, /actions\.runner/);
  assert.doesNotMatch(source, /ollama[^\n]*(pull|run)/);
  assert.doesNotMatch(source, /git[^\n]*(reset|clean|rebase|stash)/);
});
