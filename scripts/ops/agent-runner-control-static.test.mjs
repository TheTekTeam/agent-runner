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
  assert.ok(resolveStaticAsset('/agents-overview-view.mjs'));
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
  for (const pathname of ['/', '/index.html', '/agents-dashboard.css', '/agents-dashboard.js', '/agents-dashboard-view.mjs', '/agents-overview-view.mjs']) {
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
  for (const pathname of ['/index.html', '/agents-dashboard.css', '/agents-dashboard.js', '/agents-dashboard-view.mjs', '/agents-overview-view.mjs']) {
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

// -- issue #175: no external dependency of any kind --------------------

const ALL_ASSETS = ['/index.html', '/agents-dashboard.css', '/agents-dashboard.js', '/agents-dashboard-view.mjs', '/agents-overview-view.mjs'];

test('no asset references a third-party origin, CDN, external font or analytics endpoint', () => {
  // The SVG XML namespace is a document-namespace identifier passed to
  // createElementNS, never a URL anything is fetched from — it is the one
  // permitted absolute-URL literal in the bundle.
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  for (const pathname of ALL_ASSETS) {
    const body = readStaticAsset(pathname).body;
    const absoluteUrls = body.match(/https?:\/\/[^\s"'`)]+/g) || [];
    for (const url of absoluteUrls) {
      assert.equal(url, SVG_NAMESPACE, `${pathname} must not reference ${url}`);
    }
    // Anchored to a rule position so the stylesheet's own prose about not
    // importing anything is not mistaken for an actual @import rule.
    assert.ok(!/^\s*@import/m.test(body), `${pathname} must not @import anything`);
    assert.ok(!/googleapis|gstatic|cdn\.|unpkg|jsdelivr|analytics|gtag/i.test(body), `${pathname} must not reference a CDN or analytics provider`);
  }
});

test('the client only ever calls this service\'s own /api/* surface, same-origin and credentialed', () => {
  const body = readStaticAsset('/agents-dashboard.js').body;
  // `await fetch(` matches the real call site only — the module header's
  // prose about there being no other fetch() is not a call site.
  const fetchCalls = body.match(/await fetch\(/g) || [];
  assert.equal(fetchCalls.length, 1, 'there must be exactly one fetch() call site, inside apiFetch()');
  assert.ok(!/fetch\(\s*['"`]https?:/.test(body), 'fetch() must never be called with an absolute URL');
  assert.match(body, /credentials:\s*'same-origin'/);
  // Every request path passed to apiFetch is a same-origin absolute path.
  const apiPaths = body.match(/apiFetch\(\s*[`'][^`']+/g) || [];
  assert.ok(apiPaths.length > 0);
  for (const call of apiPaths) {
    const path = call.replace(/^apiFetch\(\s*[`']/, '');
    assert.ok(path.startsWith('/api/'), `apiFetch must only be called with an /api/ path, got ${path}`);
  }
  for (const pathname of ALL_ASSETS) {
    assert.ok(!/XMLHttpRequest|new WebSocket|EventSource|navigator\.sendBeacon|importScripts/.test(readStaticAsset(pathname).body), `${pathname} must not open any other network channel`);
  }
});

// -- issue #175: structure and accessibility --------------------------

test('the shell provides semantic landmarks, a skip link and a live region', () => {
  const html = readStaticAsset('/index.html').body;
  assert.match(html, /class="skip-link"[^>]*href="#main-content"/);
  assert.match(html, /<header class="topbar" role="banner">/);
  assert.match(html, /<nav class="sidenav"[^>]*aria-label="Primary">/);
  assert.match(html, /<main id="main-content"/);
  assert.match(html, /id="live-region" role="status" aria-live="polite"/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
});

test('all four required sections exist, each as a labelled section with its own heading', () => {
  const html = readStaticAsset('/index.html').body;
  for (const [panel, heading] of [
    ['panel-overview', 'overview-heading'],
    ['panel-agents', 'agents-heading'],
    ['panel-activity', 'activity-heading'],
    ['panel-settings', 'settings-heading'],
  ]) {
    assert.ok(html.includes(`id="${panel}"`), `missing ${panel}`);
    assert.ok(html.includes(`aria-labelledby="${heading}"`), `missing label for ${panel}`);
    assert.ok(html.includes(`id="${heading}"`), `missing heading ${heading}`);
  }
});

test('every form control is a real labelled input, and the drawer is an accessible dialog', () => {
  const html = readStaticAsset('/index.html').body;
  for (const id of ['login-username', 'login-password', 'add-instance-select', 'activity-query', 'activity-source']) {
    assert.ok(html.includes(`for="${id}"`), `input ${id} must have an explicit <label for>`);
    assert.ok(html.includes(`id="${id}"`));
  }
  assert.match(html, /id="agent-drawer"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="drawer-title"/);
  // Icon-only buttons still carry a text label for screen readers.
  const iconButtons = html.match(/<button[^>]*class="icon-button"[\s\S]*?<\/button>/g) || [];
  assert.ok(iconButtons.length >= 3);
  for (const button of iconButtons) {
    assert.match(button, /visually-hidden/, 'an icon-only button must carry a visually-hidden text label');
  }
});

test('dense tables have scoped headers and a caption', () => {
  const html = readStaticAsset('/index.html').body;
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  assert.ok(tables.length >= 4);
  for (const table of tables) {
    assert.match(table, /<caption/, 'every table needs a caption');
    assert.match(table, /<th scope="col">/, 'every table needs column headers');
  }
});

test('the drawer, icons and status badges never rely on colour alone', () => {
  const html = readStaticAsset('/index.html').body;
  // Every badge template carries a glyph span alongside its text span.
  const badges = html.match(/<span class="badge"[\s\S]*?<\/span>\s*<\/span>/g) || [];
  assert.ok(badges.length >= 4);
  for (const badge of badges) {
    assert.match(badge, /badge-glyph/);
    assert.match(badge, /badge-text/);
  }
  assert.match(html, /aria-hidden="true" focusable="false"/, 'decorative icons must be hidden from assistive technology');
});

test('the stylesheet ships first-class light and dark themes, reduced motion and responsive layout', () => {
  const css = readStaticAsset('/agents-dashboard.css').body;
  assert.match(css, /@media \(prefers-color-scheme: dark\)/, 'dark mode must follow the system preference first');
  assert.match(css, /:root\[data-theme="dark"\]/, 'an explicit operator override must also exist');
  assert.match(css, /:root:not\(\[data-theme="light"\]\)/, 'the system-dark block must yield to an explicit light choice');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /color-scheme: light dark/);
  assert.match(css, /:focus-visible/, 'focus must be visibly indicated');
  assert.match(css, /overflow-x: auto/, 'dense tables must scroll rather than break the layout');
});

test('no decorative animation competes with live state: nothing loops', () => {
  const css = readStaticAsset('/agents-dashboard.css').body;
  assert.ok(!/animation-iteration-count:\s*infinite/.test(css), 'no infinite animation may run for a healthy idle runner');
  assert.ok(!/\binfinite\b/.test(css.replace(/animation-iteration-count: 1 !important;/g, '')), 'no infinite animation anywhere');
});
