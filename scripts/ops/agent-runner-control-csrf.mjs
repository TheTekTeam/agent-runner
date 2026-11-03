import { timingSafeEqual } from 'node:crypto';

import { readTrustedProxyOrigin } from './agent-runner-control-trusted-origin.mjs';

/**
 * CSRF protection and strict origin validation (issue #46).
 *
 * Double-submit pattern: the session's CSRF token is returned in the login
 * response body (see `agent-runner-control-auth.mjs`), never solely in the
 * cookie, so a cross-site request — which can rely on the browser
 * automatically attaching the session cookie but cannot read that body —
 * has no way to learn the token to echo back in the required header.
 *
 * Origin validation is a second, independent layer. The normal allowlist is
 * derived from the exact loopback listener. Issue #277 adds one optional,
 * repository-managed HTTPS proxy origin loaded from the fixed control config
 * path. It is validated and normalized at process startup, then compared by
 * exact string equality just like the loopback origins. There is no wildcard,
 * forwarded-header trust, or "same host, different port" leniency.
 */

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) {
    try { timingSafeEqual(bufA, Buffer.alloc(bufA.length)); } catch { /* still falls through to false */ }
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const CSRF_HEADER_NAME = 'x-csrf-token';
const CONFIGURED_TRUSTED_PROXY_ORIGIN = readTrustedProxyOrigin();

export function validateCsrfToken({ headerToken, sessionCsrfToken } = {}) {
  if (!headerToken || !sessionCsrfToken) return { ok: false, reason: 'csrf-token-missing' };
  if (!timingSafeEqualStrings(headerToken, sessionCsrfToken)) return { ok: false, reason: 'csrf-token-mismatch' };
  return { ok: true, reason: null };
}

function originFromReferer(refererHeader) {
  if (!refererHeader) return null;
  try {
    const url = new URL(refererHeader);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * `allowedOrigins` must be supplied explicitly by the caller for the bound
 * loopback listener. `trustedProxyOrigin` defaults to the single validated
 * fixed-path configuration loaded at startup and may be injected only by
 * tests. Both paths use exact string membership; missing/foreign origins fail
 * closed.
 */
export function validateOrigin({
  originHeader,
  refererHeader,
  allowedOrigins = [],
  trustedProxyOrigin = CONFIGURED_TRUSTED_PROXY_ORIGIN,
} = {}) {
  const candidate = originHeader || originFromReferer(refererHeader);
  if (!candidate) return { ok: false, reason: 'origin-missing' };
  const accepted = trustedProxyOrigin ? [...allowedOrigins, trustedProxyOrigin] : allowedOrigins;
  if (!accepted.includes(candidate)) return { ok: false, reason: 'origin-not-allowed' };
  return { ok: true, reason: null };
}

export { CSRF_HEADER_NAME };
