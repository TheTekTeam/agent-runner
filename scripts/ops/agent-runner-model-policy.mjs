export const MODEL_POLICY_SCHEMA_VERSION = 1;
export const MODEL_IDENTITY_STATES = Object.freeze([
  'compatibility-alias',
  'qualified',
  'historically-valid',
  'unsupported',
]);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// These are the exact aliases already accepted by the live Claude runner.
// They remain compatibility identities until an exact model migration is
// separately qualified. Do not infer an underlying provider model from an
// alias and do not add guessed future full model names here.
const CLAUDE_COMPATIBILITY_ALIASES = Object.freeze({
  haiku: Object.freeze({
    adapterId: 'claude-code-cli',
    modelId: 'haiku',
    capabilityTier: 'compatibility-alias',
  }),
  sonnet: Object.freeze({
    adapterId: 'claude-code-cli',
    modelId: 'sonnet',
    capabilityTier: 'compatibility-alias',
  }),
  opus: Object.freeze({
    adapterId: 'claude-code-cli',
    modelId: 'opus',
    capabilityTier: 'compatibility-alias',
  }),
});

function token(value, name) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function optionalToken(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return token(value, name);
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`);
  return value;
}

function normalizeQualifiedEfforts(values = []) {
  if (!Array.isArray(values) || values.length > EFFORTS.size) throw new Error('qualification.supportedEfforts is invalid');
  const efforts = [...new Set(values.map((value) => token(value, 'qualification.supportedEffort')))];
  if (efforts.some((value) => !EFFORTS.has(value))) throw new Error('qualification.supportedEfforts contains an unsupported effort identity');
  return efforts.sort();
}

function normalizeQualification(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('qualification is invalid');
  const revision = optionalToken(value.revision, 'qualification.revision');
  const adapterId = optionalToken(value.adapterId, 'qualification.adapterId');
  const modelId = optionalToken(value.modelId, 'qualification.modelId');
  const cliVersion = optionalToken(value.cliVersion, 'qualification.cliVersion');
  const documentationRevision = optionalToken(value.documentationRevision, 'qualification.documentationRevision');
  const documentationVerified = value.documentationVerified === undefined ? false : boolean(value.documentationVerified, 'qualification.documentationVerified');
  const qualified = value.qualified === true;
  const supportedEfforts = normalizeQualifiedEfforts(value.supportedEfforts || []);
  const requiresExplicitMachineOptIn = value.requiresExplicitMachineOptIn === undefined
    ? false
    : boolean(value.requiresExplicitMachineOptIn, 'qualification.requiresExplicitMachineOptIn');
  return Object.freeze({
    revision,
    adapterId,
    modelId,
    cliVersion,
    documentationRevision,
    documentationVerified,
    qualified,
    supportedEfforts,
    requiresExplicitMachineOptIn,
  });
}

export function registeredClaudeCompatibilityAliases() {
  return Object.values(CLAUDE_COMPATIBILITY_ALIASES).map((entry) => ({ ...entry }));
}

export function inspectModelIdentity({ adapterId, modelId, qualification = {} } = {}) {
  const adapter = token(adapterId, 'adapterId');
  const model = token(modelId, 'modelId');
  const evidence = normalizeQualification(qualification);

  if (adapter !== 'claude-code-cli') {
    return Object.freeze({
      schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
      adapterId: adapter,
      modelId: model,
      state: 'unsupported',
      selectable: false,
      exactIdentity: false,
      historical: false,
      qualificationRevision: null,
      cliVersion: null,
      documentationRevision: null,
      supportedEfforts: Object.freeze([]),
      requiresExplicitMachineOptIn: false,
      reason: 'adapter-model-policy-not-qualified-here',
    });
  }

  const alias = CLAUDE_COMPATIBILITY_ALIASES[model];
  if (alias) {
    return Object.freeze({
      schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
      adapterId: adapter,
      modelId: model,
      state: 'compatibility-alias',
      selectable: true,
      exactIdentity: false,
      historical: true,
      qualificationRevision: null,
      cliVersion: null,
      documentationRevision: null,
      supportedEfforts: Object.freeze([]),
      requiresExplicitMachineOptIn: model === 'opus',
      reason: 'live-compatibility-alias-not-exact-model-identity',
    });
  }

  const exactQualification = Boolean(
    evidence.qualified
    && evidence.documentationVerified
    && evidence.revision
    && evidence.adapterId === adapter
    && evidence.modelId === model
    && evidence.cliVersion
    && evidence.documentationRevision,
  );

  if (!exactQualification) {
    return Object.freeze({
      schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
      adapterId: adapter,
      modelId: model,
      state: 'unsupported',
      selectable: false,
      exactIdentity: true,
      historical: false,
      qualificationRevision: null,
      cliVersion: null,
      documentationRevision: null,
      supportedEfforts: Object.freeze([]),
      requiresExplicitMachineOptIn: false,
      reason: 'exact-model-documentation-and-cli-qualification-required',
    });
  }

  return Object.freeze({
    schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
    adapterId: adapter,
    modelId: model,
    state: 'qualified',
    selectable: true,
    exactIdentity: true,
    historical: false,
    qualificationRevision: evidence.revision,
    cliVersion: evidence.cliVersion,
    documentationRevision: evidence.documentationRevision,
    supportedEfforts: Object.freeze([...evidence.supportedEfforts]),
    requiresExplicitMachineOptIn: evidence.requiresExplicitMachineOptIn,
    reason: null,
  });
}

// This helper deliberately takes the exact candidate identity as input. The
// repository does not choose or guess a future full model name. A caller may
// migrate a profile only after separate current documentation + installed CLI
// evidence has qualified that exact adapter/model/effort tuple.
export function resolveQualifiedProfileCandidate({
  profileName,
  adapterId = 'claude-code-cli',
  modelId,
  effort,
  qualification = {},
  allowExplicitMachineOptIn = false,
} = {}) {
  const profile = token(profileName, 'profileName');
  const requestedEffort = token(effort, 'effort');
  if (!EFFORTS.has(requestedEffort)) throw new Error('effort is unsupported');
  const identity = inspectModelIdentity({ adapterId, modelId, qualification });

  if (identity.state !== 'qualified' || identity.exactIdentity !== true) {
    return Object.freeze({ selected: false, profileName: profile, modelId, effort: requestedEffort, identity, reason: 'exact-qualified-model-required' });
  }
  if (!identity.supportedEfforts.includes(requestedEffort)) {
    return Object.freeze({ selected: false, profileName: profile, modelId, effort: requestedEffort, identity, reason: 'profile-effort-not-qualified' });
  }
  if (identity.requiresExplicitMachineOptIn && allowExplicitMachineOptIn !== true) {
    return Object.freeze({ selected: false, profileName: profile, modelId, effort: requestedEffort, identity, reason: 'model-requires-explicit-machine-opt-in' });
  }
  return Object.freeze({ selected: true, profileName: profile, modelId, effort: requestedEffort, identity, reason: null });
}

export function assertAttemptModelBinding({ capturedModelId, requestedModelId } = {}) {
  const captured = token(capturedModelId, 'capturedModelId');
  const requested = token(requestedModelId, 'requestedModelId');
  if (captured !== requested) throw new Error('attempt model identity changed after capture');
  return captured;
}

export function classifyHistoricalModelIdentity({ adapterId, modelId, qualification = {} } = {}) {
  const identity = inspectModelIdentity({ adapterId, modelId, qualification });
  return Object.freeze({
    adapterId: identity.adapterId,
    modelId: identity.modelId,
    historicallyValid: identity.state === 'compatibility-alias' || identity.state === 'historically-valid' || identity.state === 'qualified',
    currentlySelectable: identity.selectable,
    exactIdentity: identity.exactIdentity,
    state: identity.state,
  });
}
