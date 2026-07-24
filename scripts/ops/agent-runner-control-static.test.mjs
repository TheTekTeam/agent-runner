import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ASSET_DIR, readStaticAsset, resolveStaticAsset } from './agent-runner-control-static.mjs';

test('resolveStaticAsset only recognizes the fixed allowlisted paths', () => {
  assert.ok(resolveStaticAsset('/'));
  assert.ok(resolveStaticAsset('/index.html'));
  assert.ok(resolveStaticAsset('/agents-dashboard.css'));
  assert.ok(resolveStaticAsset('/agents-dashboard.js'));
  assert.ok(resolveStaticAsset('/agents-dashboard-view.mjs'));
  assert.equal(resolveStaticAsset('/api/instances'), null);
  assert.equal(resolveStaticAsset('/../../../etc/passwd'), null);
  assert.equal(resolveStaticAsset('/index.html/../../etc/passwd'), null);
  assert.equal(resolveStaticAsset('/nonexistent.txt'), null);
});

test('readStaticAsset never derives a filename from the request path — the file is always one of the fixed literals', () => {
  // Even a pathname engineered to look like a traversal attempt against a
  // known-good prefix resolves to nothing: STATIC_ASSETS is a map lookup,
  // never a join() against the pathname itself.
  assert.equal(readStaticAsset('/agents-dashboard.js/../../../../etc/passwd'), null);
  assert.equal(readStaticAsset('/%2e%2e/etc/passwd'), null);
});

test('every allowlisted asset actually exists on disk and is readable', () => {
  for (const pathname of ['/', '/index.html', '/agents-dashboard.css', '/agents-dashboard.js', '/agents-dashboard-view.mjs']) {
    const asset = readStaticAsset(pathname);
    assert.ok(asset, `expected an asset for ${pathname}`);
    assert.ok(asset.body.length > 0);
    assert.ok(asset.contentType.length > 0);
  }
});

test('the asset directory is the repository-shipped dashboard directory, not a temp/request-derived path', () => {
  assert.ok(existsSync(join(ASSET_DIR, 'index.html')));
});

test('index.html and the served asset content are identical (no build/transform step introduces drift)', () => {
  const direct = readFileSync(join(ASSET_DIR, 'index.html'), 'utf8');
  const served = readStaticAsset('/index.html');
  assert.equal(served.body, direct);
});

test('HTML/JS asset content never contains a secret-shaped literal or persists anything to browser storage', () => {
  for (const pathname of ['/index.html', '/agents-dashboard.css', '/agents-dashboard.js', '/agents-dashboard-view.mjs']) {
    const asset = readStaticAsset(pathname);
    assert.ok(!/sk-ant-[A-Za-z0-9_-]{20,}/.test(asset.body));
    assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(asset.body));
    // A substring ban on the word "localStorage" would also flag this file's
    // own explanatory comments; what actually matters is that nothing ever
    // *writes through* the API, so this checks for real call sites only.
    assert.ok(!/\blocalStorage\s*[.[]\s*setItem/.test(asset.body), `${pathname} must never write to localStorage`);
    assert.ok(!/\bsessionStorage\s*[.[]\s*setItem/.test(asset.body), `${pathname} must never write to sessionStorage`);
    assert.ok(!/document\.cookie\s*=/.test(asset.body), `${pathname} must never set document.cookie`);
  }
});
