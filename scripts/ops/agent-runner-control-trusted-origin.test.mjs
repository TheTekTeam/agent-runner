import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  normalizeTrustedProxyOrigin,
  readTrustedProxyOrigin,
  removeTrustedProxyOrigin,
  resolveTrustedProxyOriginPath,
  setTrustedProxyOrigin,
} from './agent-runner-control-trusted-origin.mjs';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'agent-runner-trusted-origin-'));
}

test('normalizes one exact HTTPS origin and rejects unsafe forms', () => {
  assert.equal(normalizeTrustedProxyOrigin('https://DEV-CLUSTER-DELL.tail702af6.ts.net:9443'), 'https://dev-cluster-dell.tail702af6.ts.net:9443');
  for (const value of [
    'http://dev-cluster-dell.tail702af6.ts.net:9443',
    'https://*.tail702af6.ts.net:9443',
    'https://user@dev-cluster-dell.tail702af6.ts.net:9443',
    'https://dev-cluster-dell.tail702af6.ts.net:9443/path',
    'https://dev-cluster-dell.tail702af6.ts.net:9443?x=1',
    'https://dev-cluster-dell.tail702af6.ts.net:9443#x',
    ' https://dev-cluster-dell.tail702af6.ts.net:9443',
    'https://dev-cluster-dell.tail702af6.ts.net:9443/',
  ]) assert.throws(() => normalizeTrustedProxyOrigin(value));
});

test('set/read/remove uses the fixed control config path and mode 0600', () => {
  const home = tempHome();
  try {
    const path = resolveTrustedProxyOriginPath({ HOME: home });
    const origin = 'https://dev-cluster-dell.tail702af6.ts.net:9443';
    assert.equal(setTrustedProxyOrigin({ origin, path }), origin);
    assert.equal(readTrustedProxyOrigin({ path }), origin);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(stored.origin, origin);
    assert.equal(removeTrustedProxyOrigin({ path }), true);
    assert.equal(readTrustedProxyOrigin({ path }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reader fails closed on permissive mode, malformed schema, and symlink', () => {
  const home = tempHome();
  try {
    const path = resolveTrustedProxyOriginPath({ HOME: home });
    setTrustedProxyOrigin({ origin: 'https://dev-cluster-dell.tail702af6.ts.net:9443', path });
    chmodSync(path, 0o644);
    assert.throws(() => readTrustedProxyOrigin({ path }), /0600/);
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify({ schemaVersion: 'wrong', origin: 'https://dev-cluster-dell.tail702af6.ts.net:9443' }), { mode: 0o600 });
    assert.throws(() => readTrustedProxyOrigin({ path }), /schema/);
    rmSync(path, { force: true });
    const target = join(home, 'target.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, path);
    assert.throws(() => readTrustedProxyOrigin({ path }), /regular file/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
