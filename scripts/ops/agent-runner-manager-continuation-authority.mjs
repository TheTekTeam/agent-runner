import {
  MANAGER_PREFLIGHT_ALREADY_CLAIMED,
  resolveCurrentManagerAuthority,
} from './agent-runner-manager-authority.mjs';

/**
 * Resolve the current canonical manager packet for continuation identity.
 *
 * This deliberately does not change fresh-claim semantics. A packet already
 * consumed by a matching runner-start marker remains unusable for a fresh
 * claim, but may be returned here as read-only identity evidence for a
 * bounded continuation on the already-authorised branch.
 */
export function resolveManagerContinuationAuthority(comments = []) {
  const resolved = resolveCurrentManagerAuthority(comments);

  if (resolved.allowed === true) {
    return Object.freeze({
      allowed: true,
      reason: null,
      detail: null,
      authority: resolved.authority,
      alreadyClaimed: false,
    });
  }

  if (
    resolved.reason === MANAGER_PREFLIGHT_ALREADY_CLAIMED
    && resolved.authority
  ) {
    return Object.freeze({
      allowed: true,
      reason: null,
      detail: null,
      authority: resolved.authority,
      alreadyClaimed: true,
    });
  }

  return Object.freeze({
    allowed: false,
    reason: resolved.reason,
    detail: resolved.detail || null,
    authority: null,
    alreadyClaimed: false,
  });
}
