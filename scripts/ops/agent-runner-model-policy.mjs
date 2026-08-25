export const MODEL_POLICY_SCHEMA_VERSION = 1;
export const MODEL_IDENTITY_STATES = Object.freeze([
  'qualified',
  'candidate',
  'historically-valid',
  'unsupported',
]);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;

const CLAUDE_MODEL_IDENTITIES = Object.freeze({
  'claude-sonnet-5': Object.freeze({
    adapterId: 'claude-code-cli',
    modelId: 'claude-sonnet-5',
    capabilityTier: 'sonnet',
    supportedEfforts: Object.freeze(['low', 'medium', 'high']),
    historical: false,
  }),
  'claude-opus-5': Object.freeze({
    adapterId: 'claude-code-cli',
    modelId: 'claude-opus-5',
    capabilityTier: 'opus',
    supportedEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    historical: false,
  }),
  haiku: Object.freeze({
    adapterId: 'claude-code-cli',
    modelId: 'haiku',
    capabilityTier: 'legacy-alias',
    supportedEfforts: Object.freeze(['low', 'medium', 'high']),
    historical: true,
  }),
  sonnet: Object.freeze({
    adapterId: 'claude-code-cli',
    modelId: 'sonnet',
    capabilityTier: 'legacy-alias',
    supportedEfforts: Object.freeze(['low', 'medium', 'high']),
    historical: true,
  }),
  opus: Object.freeze({
    adapterId: 'claude-code-cli',
    modelId: 'opus',
    capabilityTier: 'legacy-alias',
    supportedEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    historical: true,
  }),
});

const DEFAULT_PROFILE_CANDIDATES = Object.freeze({
  docs: Object.freeze({ adapterId: 'claude-code-cli', modelId: 'claude-sonnet-5', effort: 'low' }),
  narrow: Object.freeze({ adapterId: 'claude-code-cli', modelId: 'claude-sonnet-5', effort: 'low' }),
  complex: Object.freeze({ adapterId: 'claude-code-cli', modelId: 'claude-sonnet-5', effort: 'medium' }),
  critical: Object.freeze({ adapterId: 'claude-code-cli', modelId: 'claude-opus-5', effort: 'high' }),
});

function token(value, name) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function normalizeQualification(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('qualification is invalid');
  const revision = value.revision == null ? null : token(value.revision, 'qualification.revision');
  const adapterId = value.adapterId == null ? null : token(value.adapterId, 'qualification.adapterId');
  const modelId = value.modelId == null ? null : token(value.modelId, 'qualification.modelId');
  const cliVersion = value.cliVersion == null ? null : token(value.cliVersion, 'qualification.cliVersion');
  const qualified = value.qualified === true;
  return Object.freeze({ revision, adapterId, modelId, cliVersion, qualified });
}

export function registeredClaudeModelIdentities() {
  return Object.values(CLAUDE_MODEL_IDENTITIES).map((entry) => ({ ...entry, supportedEfforts: [...entry.supportedEfforts] }));
}

export function inspectModelIdentity({ adapterId, modelId, qualification = {} } = {}) {
  const adapter = token(adapterId, 'adapterId');
  const model = token(modelId, 'modelId');
  const evidence = normalizeQualification(qualification);
  const known = adapter === 'claude-code-cli' ? CLAUDE_MODEL_IDENTITIES[model] : null;

  if (!known || known.adapterId !== adapter) {
    return Object.freeze({
      schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
      adapterId: adapter,
      modelId: model,
      state: 'unsupported',
      selectable: false,
      historical: false,
      qualificationRevision: null,
      reason: 'model-not-registered-for-adapter',
    });
  }

  if (known.historical) {
    return Object.freeze({
      schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
      adapterId: adapter,
      modelId: model,
      state: 'historically-valid',
      selectable: false,
      historical: true,
      qualificationRevision: null,
      reason: 'historical-identity-not-selectable-for-new-attempt',
    });
  }

  const exactQualification = evidence.qualified
    && evidence.revision
    && evidence.adapterId === adapter
    && evidence.modelId === model
    && evidence.cliVersion;
  return Object.freeze({
    schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
    adapterId: adapter,
    modelId: model,
    state: exactQualification ? 'qualified' : 'candidate',
    selectable: Boolean(exactQualification),
    historical: false,
    qualificationRevision: exactQualification ? evidence.revision : null,
    cliVersion: exactQualification ? evidence.cliVersion : null,
    reason: exactQualification ? null : 'exact-installed-cli-qualification-required',
  });
}

export function resolveProfileModelCandidate(profileName, { qualification = {}, allowOpus = false } = {}) {
  const profile = token(profileName, 'profileName');
  const candidate = DEFAULT_PROFILE_CANDIDATES[profile];
  if (!candidate) throw new Error('profileName is unsupported');
  const identity = inspectModelIdentity({ adapterId: candidate.adapterId, modelId: candidate.modelId, qualification });
  if (!identity.selectable) {
    return Object.freeze({ selected: false, profileName: profile, candidate, identity, reason: identity.reason });
  }
  if (candidate.modelId === 'claude-opus-5' && allowOpus !== true) {
    return Object.freeze({ selected: false, profileName: profile, candidate, identity, reason: 'opus-requires-explicit-machine-opt-in' });
  }
  return Object.freeze({ selected: true, profileName: profile, candidate, identity, reason: null });
}

export function assertAttemptModelBinding({ capturedModelId, requestedModelId } = {}) {
  const captured = token(capturedModelId, 'capturedModelId');
  const requested = token(requestedModelId, 'requestedModelId');
  if (captured !== requested) throw new Error('attempt model identity changed after capture');
  return captured;
}

export function classifyHistoricalModelIdentity({ adapterId, modelId } = {}) {
  const identity = inspectModelIdentity({ adapterId, modelId });
  return Object.freeze({
    adapterId: identity.adapterId,
    modelId: identity.modelId,
    historicallyValid: identity.state === 'historically-valid' || identity.state === 'candidate' || identity.state === 'qualified',
    currentlySelectable: identity.selectable,
    state: identity.state,
  });
}
