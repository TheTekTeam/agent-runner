import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static asset serving for the authenticated Agents dashboard shell (issue
 * #47). This is a positive path -> literal-filename allowlist: there is no
 * `join(dir, req.url)` anywhere in this module, so a request path can never
 * select any file outside the four entries below, let alone traverse
 * outside `ASSET_DIR`. `resolveStaticAsset()` looks a pathname up in a
 * frozen map and returns either `null` or one of the fixed `{ file,
 * contentType }` records; the filename that actually reaches `readFileSync`
 * is always one of those literals, never anything derived from request
 * input.
 *
 * These GET-only reads are intentionally served *before* the control API's
 * origin/auth/CSRF gate (see `agent-runner-control-server.mjs`): a top-level
 * browser navigation to load the page sends no `Origin` header at all, so
 * gating the HTML shell behind `validateOrigin()` would make the page
 * un-loadable. This is safe because the shell carries no agent, settings,
 * secret, session or audit data of any kind — the same trust level as the
 * existing static read-only dashboard already published to `/var/www`, and
 * strictly less exposed, since this service only ever binds loopback (see
 * `resolveBindHost()`). Every dynamic value the page displays is fetched
 * client-side, after the page has loaded, through the fully
 * authenticated/CSRF/origin-checked `/api/*` surface.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = resolve(__dirname, '../../.agent-runner/agents-dashboard');

const STATIC_ASSETS = Object.freeze({
  '/': Object.freeze({ file: 'index.html', contentType: 'text/html; charset=utf-8' }),
  '/index.html': Object.freeze({ file: 'index.html', contentType: 'text/html; charset=utf-8' }),
  '/agents-dashboard.css': Object.freeze({ file: 'agents-dashboard.css', contentType: 'text/css; charset=utf-8' }),
  '/agents-dashboard.js': Object.freeze({ file: 'agents-dashboard.js', contentType: 'text/javascript; charset=utf-8' }),
  '/agents-dashboard-view.mjs': Object.freeze({ file: 'agents-dashboard-view.mjs', contentType: 'text/javascript; charset=utf-8' }),
});

/** A strict Content-Security-Policy: the dashboard never needs a third-party origin for anything. */
export const STATIC_CSP_HEADER = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function resolveStaticAsset(pathname) {
  return STATIC_ASSETS[pathname] || null;
}

/**
 * Read one allowlisted asset. Returns `null` for anything not in the
 * allowlist — callers must fall through to their normal 404 handling rather
 * than treat `null` as an error.
 */
export function readStaticAsset(pathname, { assetDir = ASSET_DIR, readFn = readFileSync } = {}) {
  const asset = resolveStaticAsset(pathname);
  if (!asset) return null;
  const fullPath = join(assetDir, asset.file);
  return { body: readFn(fullPath, 'utf8'), contentType: asset.contentType };
}

export { ASSET_DIR };
