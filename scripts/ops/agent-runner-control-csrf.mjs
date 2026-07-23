import { timingSafeEqual } from 'node:crypto';

/**
 * CSRF protection and strict origin validation (issue #46).
 *
 * Double-submit pattern: the session's CSRF token is returned in the login
 * response body (see `agent-runner-control-auth.mjs`), never solely in the
 * cookie, so a cross-site request — which can rely on the browser
 * automatically attaching the session cookie but cannot read that body —
 * has no way to learn the token to echo back in the required header.
 *
 * Origin validation is a second, independent layer: every mutating request
 * must present an `Origin` (or, failing that, `Referer`) header that
 * exactly matches one of the loopback origins this service is actually
 * bound to. There is no wildcard and no "same host, different port"
 * leniency — a mismatch or an absent header both fail closed.
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
 * `allowedOrigins` must be supplied explicitly by the caller (the server
 * knows exactly which loopback host:port it bound to) — there is no
 * built-in default and no environment-derived allowlist here, so this
 * module cannot itself be tricked into trusting an unexpected origin.
 */
export function validateOrigin({ originHeader, refererHeader, allowedOrigins = [] } = {}) {
  const candidate = originHeader || originFromReferer(refererHeader);
  if (!candidate) return { ok: false, reason: 'origin-missing' };
  if (!allowedOrigins.includes(candidate)) return { ok: false, reason: 'origin-not-allowed' };
  return { ok: true, reason: null };
}

export { CSRF_HEADER_NAME };
