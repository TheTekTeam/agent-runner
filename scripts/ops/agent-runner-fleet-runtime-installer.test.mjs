import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const SCRIPT = new URL('../install-agent-runner-fleet-runtime.sh', import.meta.url);
const SAFE_TEST_PATH = mkdtempSync(join(tmpdir(), 'agent-runner-fleet-runtime-test-'));
const ID_SHIM = join(SAFE_TEST_PATH, 'id');
const CAT_SHIM = join(SAFE_TEST_PATH, 'cat');

writeFileSync(
  ID_SHIM,
  '#!/bin/sh\nif [ "$1" = "-u" ]; then printf "1000\\n"; exit 0; fi\nexit 1\n',
);
chmodSync(ID_SHIM, 0o755);
writeFileSync(
  CAT_SHIM,
  '#!/bin/sh\nwhile IFS= read -r line || [ -n "$line" ]; do printf "%s\\n" "$line"; done\n',
);
chmodSync(CAT_SHIM, 0o755);
after(() => rmSync(SAFE_TEST_PATH, { recursive: true, force: true }));

function run(args) {
  return spawnSync('/usr/bin/bash', [SCRIPT.pathname, ...args], {
    encoding: 'utf8',
    env: {
      PATH: SAFE_TEST_PATH,
      HOME: process.env.HOME || '/tmp',
    },
  });
}

test('fleet runtime installer documents bounded Claude, Codex and Ollama/OpenCode contracts', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude-code-cli/);
  assert.match(result.stdout, /codex-cli/);
  assert.match(result.stdout, /ollama-agent/);
  assert.match(result.stdout, /Ubuntu\/Debian/);
  assert.match(result.stdout, /signed stable apt repository/);
  assert.match(result.stdout, /@openai\/codex npm package/);
  assert.match(result.stdout, /official Linux tarball/);
  assert.match(result.stdout, /opencode-ai npm package/);
  assert.match(result.stdout, /does not perform provider\s+login\/authentication/i);
});

test('Claude fleet runtime installer dry-run performs no package, auth, scheduler or routing mutation', () => {
  const result = run(['--adapter', 'claude-code-cli', '--worker-only', '--dry-run']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /worker-only mode/);
  assert.match(result.stdout, /--dry-run: would .*Anthropic signing key/);
  assert.match(result.stdout, /31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE/);
  assert.match(result.stdout, /stable repository https:\/\/downloads\.claude\.ai\/claude-code\/apt\/stable/);
  assert.match(result.stdout, /install package claude-code through apt/);
});

test('Codex fleet runtime installer dry-run uses only the reviewed official npm package and performs no auth', () => {
  const result = run(['--adapter', 'codex-cli', '--worker-only', '--dry-run']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /worker-only mode/);
  assert.match(result.stdout, /existing reviewed Node\/npm toolchain/);
  assert.match(result.stdout, /@openai\/codex@latest globally from https:\/\/registry\.npmjs\.org\//);
  assert.match(result.stdout, /verify codex --version/);
  assert.match(result.stdout, /would not run codex login/);
  assert.match(result.stdout, /would not .*inspect\/copy ~\/\.codex authentication state/);
});

test('Ollama fleet runtime installer dry-run binds official runtime and OpenCode sources without models or services', () => {
  const result = run(['--adapter', 'ollama-agent', '--worker-only', '--dry-run']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /worker-only mode/);
  assert.match(result.stdout, /official Ollama Linux tarball/);
  assert.match(result.stdout, /https:\/\/ollama\.com\/download/);
  assert.match(result.stdout, /would not create\/start\/enable an Ollama service/);
  assert.match(result.stdout, /would not pull or run any model/);
  assert.match(result.stdout, /opencode-ai@latest globally from https:\/\/registry\.npmjs\.org\//);
  assert.match(result.stdout, /verify ollama -v and opencode --version/);
});

test('fleet runtime installer keeps Grok owner-deferred instead of guessing install commands', () => {
  const result = run(['--adapter', 'grok-cli', '--dry-run']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /owner-deferred/);
});

test('fleet runtime installer source pins reviewed package inputs and excludes forbidden authority/auth paths', async () => {
  const source = await readFile(SCRIPT, 'utf8');

  assert.match(source, /https:\/\/downloads\.claude\.ai\/keys\/claude-code\.asc/);
  assert.match(source, /https:\/\/downloads\.claude\.ai\/claude-code\/apt\/stable/);
  assert.match(source, /31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE/);
  assert.match(source, /sudo apt-get install -y claude-code/);
  assert.match(source, /gpg --show-keys --with-colons/);

  assert.match(source, /CODEX_NPM_PACKAGE="@openai\/codex"/);
  assert.match(source, /CODEX_NPM_PACKAGE_SPEC="@openai\/codex@latest"/);
  assert.match(source, /CODEX_NPM_REGISTRY="https:\/\/registry\.npmjs\.org\/"/);
  assert.match(source, /sudo "\$NPM_BIN" install --global/);
  assert.match(source, /--no-audit/);
  assert.match(source, /--no-fund/);
  assert.match(source, /codex --version/);

  assert.match(source, /OLLAMA_DOWNLOAD_BASE="https:\/\/ollama\.com\/download"/);
  assert.match(source, /ollama-linux-\$OLLAMA_ARCH\.tar\.zst/);
  assert.match(source, /sudo tar --zstd -xf/);
  assert.match(source, /OPENCODE_NPM_PACKAGE="opencode-ai"/);
  assert.match(source, /OPENCODE_NPM_PACKAGE_SPEC="opencode-ai@latest"/);
  assert.match(source, /opencode --version/);

  assert.doesNotMatch(source, /curl[^\n]*\|[^\n]*(bash|sh)/);
  assert.doesNotMatch(source, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(source, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.doesNotMatch(source, /OPENAI_API_KEY/);
  assert.doesNotMatch(source, /CODEX_API_KEY/);
  assert.doesNotMatch(source, /codex[[:space:]]+login/);
  assert.doesNotMatch(source, /systemctl[^\n]*(enable|start|restart)/);
  assert.doesNotMatch(source, /actions\.runner/);
  // Reject executable model-management commands, not safety/help text such
  // as "would not pull or run any model".
  assert.doesNotMatch(source, /^[ \t]*(?:sudo[ \t]+)?ollama[ \t]+(?:pull|run)\b/m);
  assert.doesNotMatch(source, /git[^\n]*(reset|clean|rebase|stash)/);
});
