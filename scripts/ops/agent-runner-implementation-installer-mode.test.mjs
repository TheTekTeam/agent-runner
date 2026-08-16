import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installer = path.join(repoRoot, 'scripts/install-agent-runner-implementation-systemd.sh');

test('generic implementation systemd installer is repository-executable', () => {
  const mode = statSync(installer).mode & 0o777;
  assert.notEqual(mode & 0o111, 0, `expected executable installer mode, got ${mode.toString(8)}`);
});
