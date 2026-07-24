#!/usr/bin/env node

// Deterministic serial multi-agent selector (issue #50).
//
// This module is a pure function over caller-supplied candidate
// descriptions -- it never reads a settings file, calls GitHub, spawns a
// process, or invokes a model. `claude-runner-cron.mjs` is the only place
// that gathers the real per-agent signals (a settings snapshot, readiness
// probes, Claude's own quota preflight) and calls in; every other caller
// (tests, future callers) can inject the same shape directly, including
// synthetic future-implemented adapters, without touching the real
// catalogue or any live provider.
//
// There is no weighting, randomness, or model-generated ranking anywhere in
// this file: the outcome is a deterministic first-eligible-match scan over
// a caller-ordered candidate list, and exactly one agent (or none) is ever
// selected -- this module has no notion of parallel workers or per-agent
// slots; the caller's single global execution slot is represented by the
// `globalSlotAvailable` boolean input.

import { assessQualification } from './agent-runner-qualification.mjs';

export const GLOBAL_EXECUTION_SLOT_CAPACITY = 1;

// A future implemented paid adapter (Codex CLI, Grok CLI today) is never an
// automatic fallback merely because it is installed, enabled, or qualified.
// This local list, not a field on the shared frozen catalogue, is the only
// place "paid" is asserted -- it does not mutate agent-runner-agents.mjs.
export const PAID_AGENT_IDS = Object.freeze(['codex-cli', 'grok-cli']);

function isPaidAgent(agentId) {
  return PAID_AGENT_IDS.includes(agentId);
}

/**
 * `hasGlobalSlotAvailable` is a read of the existing serial global execution
 * slot, matching the same `capacity: 1` contract
 * `agent-runner-control-readiness.mjs#computeInstanceLoad()` already
 * exposes -- nothing here (or anywhere in this issue's scope) can raise it.
 */
export function hasGlobalSlotAvailable(activeCount = 0) {
  return activeCount < GLOBAL_EXECUTION_SLOT_CAPACITY;
}

function paidRoutingReasons({ agentId, adapter, paidUse }) {
  if (!isPaidAgent(agentId)) return [];
  const reasons = [];
  if (!adapter?.implemented) return reasons; // already excluded by the implemented check; avoid a redundant reason
  if (paidUse?.automaticRoutingApproved !== true) reasons.push('automatic-routing-not-approved');
  if (paidUse?.paidUseApproved !== true) reasons.push('paid-use-not-approved');
  if (paidUse?.hasPositiveCap !== true) reasons.push('no-positive-cost-or-token-cap');
  return reasons;
}

/**
 * Every applicable check from issue #50's eligibility list, in order, each
 * producing its own bounded reason code so a caller can explain retention,
 * exclusion, or unavailability without ever echoing raw settings, paths, or
 * secrets. `readiness`/`resourceState` are optional caller-supplied signals
 * (health/ready probes, an agent-local quota/resource block) -- omitted,
 * they simply do not exclude the candidate.
 */
export function evaluateAgentEligibility({
  agentId,
  adapter = null,
  settingsEntry = null,
  classification = { taskClass: null, riskClass: null, model: null, harness: null },
  readiness = null,
  resourceState = null,
} = {}) {
  const reasons = [];

  if (!adapter) reasons.push('not-in-approved-catalogue');
  else if (!adapter.implemented) reasons.push('not-implemented');

  if (!settingsEntry) {
    reasons.push('no-settings-entry');
  } else {
    if (settingsEntry.lifecycle?.disabled) reasons.push('agent-disabled');
    else if (!settingsEntry.lifecycle?.enabled) reasons.push('agent-not-enabled');
    if (settingsEntry.lifecycle?.paused) reasons.push('agent-paused');
    if (settingsEntry.lifecycle?.draining) reasons.push('agent-draining');
  }

  // Readiness is mandatory (issue #50 review, requirement 5): a candidate
  // whose readiness was never proven is excluded exactly like one proven
  // unhealthy -- absence of a probe result must never be read as "passing".
  if (!readiness || typeof readiness !== 'object') reasons.push('readiness-not-proven');
  else if (readiness.healthy !== true || readiness.ready !== true) reasons.push('agent-unhealthy-or-not-ready');

  if (settingsEntry) {
    const qualification = assessQualification({ agentId, qualification: settingsEntry.qualification, classification });
    if (!qualification.qualified) reasons.push(...qualification.reasons);
  }

  if (resourceState?.blocked) reasons.push(resourceState.reason || 'agent-resource-blocked');

  if (settingsEntry) reasons.push(...paidRoutingReasons({ agentId, adapter, paidUse: settingsEntry.paidUse }));

  return { agentId, status: reasons.length === 0 ? 'eligible' : 'excluded', reasons };
}

/**
 * One deterministic selection pass for a single issue. `candidates` must
 * already be in the caller's canonical order (the frozen catalogue order is
 * a good default) -- this function never reorders, scores, or samples them.
 *
 * `explicitAgentId` is the issue's current explicit `agent:*` assignment,
 * if any. It is retained whenever it remains eligible; otherwise the first
 * eligible non-explicit candidate is selected and `reassigned` is reported
 * true so the caller knows a reassignment (not a first assignment) took
 * place. When no candidate is eligible, `selectedAgentId` is `null` and
 * `reason` is `'no-qualified-agent'` -- the caller must launch nothing.
 */
export function selectAgentForIssue({
  explicitAgentId = null,
  candidates = [],
  classification = { taskClass: null, riskClass: null, model: null, harness: null },
  globalSlotAvailable = true,
} = {}) {
  const decisions = candidates.map((candidate) => ({
    ...evaluateAgentEligibility({ ...candidate, classification }),
    isExplicitAssignment: Boolean(explicitAgentId) && candidate.agentId === explicitAgentId,
  }));

  if (!globalSlotAvailable) {
    return { selectedAgentId: null, reassigned: false, reason: 'global-slot-unavailable', explicitAgentId, decisions };
  }

  const explicitDecision = explicitAgentId ? decisions.find((decision) => decision.agentId === explicitAgentId) : null;
  if (explicitDecision?.status === 'eligible') {
    return { selectedAgentId: explicitAgentId, reassigned: false, reason: 'explicit-assignment-retained', explicitAgentId, decisions };
  }

  const alternative = decisions.find((decision) => decision.agentId !== explicitAgentId && decision.status === 'eligible');
  if (alternative) {
    return {
      selectedAgentId: alternative.agentId,
      reassigned: Boolean(explicitAgentId),
      reason: 'alternative-agent-selected',
      explicitAgentId,
      decisions,
    };
  }

  return { selectedAgentId: null, reassigned: false, reason: 'no-qualified-agent', explicitAgentId, decisions };
}
