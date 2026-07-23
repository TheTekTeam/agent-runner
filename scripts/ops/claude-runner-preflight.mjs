#!/usr/bin/env node

// Compatibility tombstone for the retired local manager-preflight generator.
//
// Manager authority may be authored only by a normal ChatGPT manager session
// or a ChatGPT scheduled task. This module intentionally contains no packet
// construction, refresh, fingerprinting or GitHub-mutation capability. It is
// retained at the historical import path so stale consumers fail closed with
// an explicit reason instead of silently falling back to generation.

export const PREFLIGHT_GENERATION_NEEDS_MANAGER = 'manager-preflight-required';
export const PREFLIGHT_GENERATION_RETIRED = 'preflight-generation-retired';

export function buildGeneratedPreflightPacket() {
  throw new Error(PREFLIGHT_GENERATION_RETIRED);
}

export function resolvePreflightAction({ issue } = {}) {
  if (issue?.statusLabel !== 'status:ready') {
    return { action: 'noop', reason: PREFLIGHT_GENERATION_RETIRED, detail: 'automatic manager-preflight generation is retired' };
  }
  return {
    action: 'blocked',
    reason: PREFLIGHT_GENERATION_NEEDS_MANAGER,
    detail: 'A current canonical manager packet must be authored by a normal ChatGPT manager session or ChatGPT scheduled task. The runner cannot generate or refresh manager authority.',
  };
}
