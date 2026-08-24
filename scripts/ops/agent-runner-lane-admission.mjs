export const LANE_ADMISSION_SCHEMA_VERSION = 1;

function integer(value, name, { min = 0, max = 128 } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} is invalid`);
  return number;
}

function token(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function normalizedSet(values = [], name) {
  if (!Array.isArray(values) || values.length > 256) throw new Error(`${name} is invalid`);
  return [...new Set(values.map((value) => token(value, name)))].sort();
}

export function normalizeLaneCandidate(raw = {}) {
  const candidate = {
    laneId: token(raw.laneId, 'laneId'),
    projectId: token(raw.projectId, 'projectId'),
    repository: token(raw.repository, 'repository'),
    issueNumber: integer(raw.issueNumber, 'issueNumber', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    agentInstanceId: token(raw.agentInstanceId, 'agentInstanceId'),
    adapterId: token(raw.adapterId, 'adapterId'),
    nodeId: token(raw.nodeId, 'nodeId'),
    branch: token(raw.branch, 'branch'),
    worktree: token(raw.worktree, 'worktree'),
    partitionId: raw.partitionId ? token(raw.partitionId, 'partitionId') : null,
    integrationOrder: raw.integrationOrder === undefined || raw.integrationOrder === null
      ? null
      : integer(raw.integrationOrder, 'integrationOrder', { min: 0, max: 10_000 }),
    files: normalizedSet(raw.files || [], 'files'),
    resources: normalizedSet(raw.resources || [], 'resources'),
  };
  return Object.freeze(candidate);
}

export function normalizeLaneCaps(raw = {}) {
  const perRepository = {};
  const perAgent = {};
  const perNode = {};
  for (const [key, value] of Object.entries(raw.perRepository || {})) perRepository[token(key, 'repository cap key')] = integer(value, 'repository cap', { min: 1, max: 128 });
  for (const [key, value] of Object.entries(raw.perAgent || {})) perAgent[token(key, 'agent cap key')] = integer(value, 'agent cap', { min: 1, max: 128 });
  for (const [key, value] of Object.entries(raw.perNode || {})) perNode[token(key, 'node cap key')] = integer(value, 'node cap', { min: 1, max: 128 });
  return Object.freeze({
    global: integer(raw.global ?? 1, 'global cap', { min: 1, max: 128 }),
    defaultPerRepository: integer(raw.defaultPerRepository ?? 1, 'default repository cap', { min: 1, max: 128 }),
    defaultPerAgent: integer(raw.defaultPerAgent ?? 1, 'default agent cap', { min: 1, max: 128 }),
    defaultPerNode: integer(raw.defaultPerNode ?? raw.global ?? 1, 'default node cap', { min: 1, max: 128 }),
    perRepository: Object.freeze(perRepository),
    perAgent: Object.freeze(perAgent),
    perNode: Object.freeze(perNode),
  });
}

function countBy(lanes, selector, value) {
  return lanes.reduce((count, lane) => count + (selector(lane) === value ? 1 : 0), 0);
}

function overlaps(left, right) {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

export function laneCollisionReasons(candidateInput, activeInputs = []) {
  const candidate = normalizeLaneCandidate(candidateInput);
  const active = activeInputs.map(normalizeLaneCandidate);
  const reasons = [];

  for (const lease of active) {
    if (lease.laneId === candidate.laneId) {
      reasons.push('lane-id-already-active');
      continue;
    }
    if (lease.repository !== candidate.repository) continue;

    if (lease.branch === candidate.branch) reasons.push(`branch-collision:${lease.laneId}`);
    if (lease.worktree === candidate.worktree) reasons.push(`worktree-collision:${lease.laneId}`);
    if (overlaps(candidate.files, lease.files)) reasons.push(`file-collision:${lease.laneId}`);
    if (overlaps(candidate.resources, lease.resources)) reasons.push(`resource-collision:${lease.laneId}`);

    if (lease.issueNumber === candidate.issueNumber) {
      const partitionsExplicit = Boolean(candidate.partitionId && lease.partitionId);
      const partitionsDistinct = partitionsExplicit && candidate.partitionId !== lease.partitionId;
      const integrationExplicit = candidate.integrationOrder !== null && lease.integrationOrder !== null;
      if (!partitionsExplicit) reasons.push(`same-issue-partition-missing:${lease.laneId}`);
      else if (!partitionsDistinct) reasons.push(`same-issue-partition-collision:${lease.laneId}`);
      if (!integrationExplicit) reasons.push(`same-issue-integration-order-missing:${lease.laneId}`);
      else if (candidate.integrationOrder === lease.integrationOrder) reasons.push(`same-issue-integration-order-collision:${lease.laneId}`);
    }
  }
  return [...new Set(reasons)].sort();
}

export function laneCapacityReasons(candidateInput, activeInputs = [], capsInput = {}) {
  const candidate = normalizeLaneCandidate(candidateInput);
  const active = activeInputs.map(normalizeLaneCandidate);
  const caps = normalizeLaneCaps(capsInput);
  const reasons = [];
  if (active.length >= caps.global) reasons.push('global-cap-full');
  const repoCap = caps.perRepository[candidate.repository] ?? caps.defaultPerRepository;
  if (countBy(active, (lane) => lane.repository, candidate.repository) >= repoCap) reasons.push('repository-cap-full');
  const agentCap = caps.perAgent[candidate.agentInstanceId] ?? caps.perAgent[candidate.adapterId] ?? caps.defaultPerAgent;
  if (countBy(active, (lane) => lane.agentInstanceId, candidate.agentInstanceId) >= agentCap) reasons.push('agent-cap-full');
  const nodeCap = caps.perNode[candidate.nodeId] ?? caps.defaultPerNode;
  if (countBy(active, (lane) => lane.nodeId, candidate.nodeId) >= nodeCap) reasons.push('node-cap-full');
  return reasons.sort();
}

export function admitLane(candidateInput, { active = [], caps = {} } = {}) {
  const candidate = normalizeLaneCandidate(candidateInput);
  const collisionReasons = laneCollisionReasons(candidate, active);
  const capacityReasons = laneCapacityReasons(candidate, active, caps);
  const reasons = [...new Set([...collisionReasons, ...capacityReasons])].sort();
  return Object.freeze({
    admitted: reasons.length === 0,
    candidate,
    reasons,
    schemaVersion: LANE_ADMISSION_SCHEMA_VERSION,
  });
}

/**
 * Admit independent candidates in deterministic input order. A blocked lane is
 * recorded and skipped; unrelated later candidates still receive a chance.
 * Newly admitted lanes immediately count against later capacity/collision
 * checks, matching atomic scheduler allocation semantics.
 */
export function admitLaneBatch(candidates = [], { active = [], caps = {} } = {}) {
  if (!Array.isArray(candidates) || candidates.length > 256) throw new Error('candidates is invalid');
  const admitted = [];
  const rejected = [];
  const working = active.map(normalizeLaneCandidate);
  for (const raw of candidates) {
    const result = admitLane(raw, { active: working, caps });
    if (result.admitted) {
      admitted.push(result.candidate);
      working.push(result.candidate);
    } else {
      rejected.push({ laneId: result.candidate.laneId, reasons: result.reasons });
    }
  }
  return Object.freeze({ schemaVersion: LANE_ADMISSION_SCHEMA_VERSION, admitted, rejected });
}

export function reconcileLaneLeases(leases = [], { liveLaneIds = [], now = new Date(), expiryByLane = {} } = {}) {
  const live = new Set(normalizedSet(liveLaneIds, 'liveLaneIds'));
  const retained = [];
  const stale = [];
  for (const raw of leases) {
    const lease = normalizeLaneCandidate(raw);
    const expiryRaw = expiryByLane[lease.laneId];
    const expiry = expiryRaw ? new Date(expiryRaw) : null;
    const expired = expiry && Number.isFinite(expiry.getTime()) && expiry.getTime() <= new Date(now).getTime();
    if (live.has(lease.laneId) && !expired) retained.push(lease);
    else stale.push({ laneId: lease.laneId, reason: expired ? 'lease-expired' : 'owner-not-live' });
  }
  return Object.freeze({ retained, stale });
}
