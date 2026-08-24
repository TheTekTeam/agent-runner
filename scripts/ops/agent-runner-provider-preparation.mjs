import {
  buildDeterministicHandoffCapsule,
  evaluateDeterministicCompletion,
  executeDeterministicPreflight,
  planDeterministicPreflight,
} from './agent-runner-deterministic-preflight.mjs';
import {
  buildBoundedContextCapsule,
  chooseContextBudget,
  contextBudgetTelemetry,
  decideSessionLifecycle,
} from './agent-runner-context-budget.mjs';

export const PROVIDER_PREPARATION_SCHEMA_VERSION = 1;

const SAFE_DEFAULT_CAPABILITIES = Object.freeze([
  'repository-identity',
  'git-status',
  'changed-files',
  'repository-map',
  'toolchain-facts',
]);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is required`);
}

function defaultCapabilities({ includeDiffCheck = false } = {}) {
  return includeDiffCheck ? [...SAFE_DEFAULT_CAPABILITIES, 'diff-check'] : [...SAFE_DEFAULT_CAPABILITIES];
}

function deterministicSections(execution, handoff) {
  return [
    {
      kind: 'source',
      required: true,
      value: {
        sourceFingerprint: execution.sourceIdentity.sourceFingerprint,
        headSha: execution.sourceIdentity.headSha,
        treeSha: execution.sourceIdentity.treeSha,
        dirtyFingerprint: execution.sourceIdentity.dirtyFingerprint,
      },
      maxBytes: 2048,
    },
    {
      kind: 'deterministicEvidence',
      value: handoff,
      maxBytes: 12 * 1024,
    },
  ];
}

/**
 * Provider-neutral issue preparation boundary for #319/#320.
 *
 * All deterministic operations are selected from structured configuration;
 * free-form issue text is context only and never becomes executable argv.
 * Optional accelerators may fail without blocking provider autonomy. A
 * required deterministic operation must succeed before provider eligibility.
 */
export function prepareProviderWork({
  project,
  taskIdentity,
  authority = {},
  configuration = {},
  requestedCapabilities = null,
  deterministicOptions = {},
  machineVerifiableCompletion = false,
  taskClass = 'normal',
  risk = 'normal',
  adapterCapabilities = {},
  requestedReasoningEffort = null,
  session = null,
  recovery = null,
  providerContext = {},
  contextSections = [],
  priorAcceptedEvidence = [],
} = {}) {
  assertObject(project, 'project');
  assertObject(taskIdentity, 'taskIdentity');
  if (!Array.isArray(contextSections)) throw new Error('contextSections must be an array');

  const capabilities = requestedCapabilities || defaultCapabilities({
    includeDiffCheck: configuration.includeDiffCheck === true,
  });
  if (!Array.isArray(capabilities)) throw new Error('requestedCapabilities must be an array');

  // Built-in read-only capabilities still require a positive two-sided gate:
  // controller authority and project configuration must both name them. The
  // integration helper provides conservative defaults only when the caller
  // explicitly opts into `defaultReadOnlyPreflight`.
  const allowDefaults = configuration.defaultReadOnlyPreflight === true;
  const configured = Array.isArray(configuration.deterministicCapabilities)
    ? configuration.deterministicCapabilities
    : allowDefaults ? defaultCapabilities({ includeDiffCheck: configuration.includeDiffCheck === true }) : [];
  const authorised = Array.isArray(authority.deterministicCapabilities)
    ? authority.deterministicCapabilities
    : allowDefaults ? configured : [];

  const plan = planDeterministicPreflight({
    project,
    authority: { ...authority, deterministicCapabilities: authorised },
    configuration: { ...configuration, deterministicCapabilities: configured },
    requestedCapabilities: capabilities,
    limits: deterministicOptions.limits,
  });
  const execution = executeDeterministicPreflight({
    plan,
    configuration,
    evidenceRoot: deterministicOptions.evidenceRoot,
    mapCacheRoot: deterministicOptions.mapCacheRoot,
    limits: deterministicOptions.limits,
    now: deterministicOptions.now,
  });
  const deterministicCompletion = evaluateDeterministicCompletion({ execution, machineVerifiableCompletion });
  const handoff = buildDeterministicHandoffCapsule(execution, { limits: deterministicOptions.limits });

  if (!execution.providerEligible) {
    return Object.freeze({
      schemaVersion: PROVIDER_PREPARATION_SCHEMA_VERSION,
      providerEligible: false,
      providerInvocationRequired: false,
      completedWithoutProvider: false,
      reason: 'required-deterministic-evidence-unavailable',
      deterministic: handoff,
      lifecycle: null,
      budget: null,
      contextCapsule: null,
      providerControls: null,
      telemetry: contextBudgetTelemetry({ deterministic: { evidenceReused: execution.evidenceReused, providerInvocationAvoided: true } }),
    });
  }

  if (deterministicCompletion.completedWithoutProvider) {
    return Object.freeze({
      schemaVersion: PROVIDER_PREPARATION_SCHEMA_VERSION,
      providerEligible: true,
      providerInvocationRequired: false,
      completedWithoutProvider: true,
      reason: deterministicCompletion.reason,
      deterministic: handoff,
      lifecycle: null,
      budget: null,
      contextCapsule: null,
      providerControls: null,
      telemetry: contextBudgetTelemetry({ deterministic: { evidenceReused: execution.evidenceReused, providerInvocationAvoided: true } }),
    });
  }

  const lifecycle = decideSessionLifecycle({ taskIdentity, session, recovery, provider: providerContext, context: providerContext });
  const budget = chooseContextBudget({ taskClass, risk, adapterCapabilities, requestedReasoningEffort });
  const capsule = buildBoundedContextCapsule({
    budget,
    priorAcceptedEvidence,
    sections: [
      ...contextSections,
      ...deterministicSections(execution, handoff),
    ],
  });

  return Object.freeze({
    schemaVersion: PROVIDER_PREPARATION_SCHEMA_VERSION,
    providerEligible: true,
    providerInvocationRequired: true,
    completedWithoutProvider: false,
    reason: 'provider-reasoning-required',
    deterministic: handoff,
    lifecycle,
    budget,
    contextCapsule: capsule,
    providerControls: budget.providerControls,
    telemetry: contextBudgetTelemetry({
      lifecycle,
      budget,
      capsule,
      deterministic: { evidenceReused: execution.evidenceReused, providerInvocationAvoided: false },
    }),
  });
}

export function defaultProviderPreparationCapabilities(options = {}) {
  return Object.freeze(defaultCapabilities(options));
}
