/**
 * @typedef {Readonly<{ version: 1, nodeId: string|null, databaseId: number|null }>} CommentIdentity
 */

export const COMMENT_IDENTITY_VERSION = 1;

export class CommentIdentityError extends Error {
  constructor(code, context = 'comment') {
    const boundedContext = String(context || 'comment').replace(/[^a-z0-9:_-]+/gi, '-').slice(0, 80) || 'comment';
    const messages = {
      'identity-unavailable': `No proven GitHub comment identity is available for ${boundedContext}`,
      'identity-conflict': `Conflicting GitHub comment identity evidence was supplied for ${boundedContext}`,
      'identity-version-unsupported': `Unsupported GitHub comment identity version for ${boundedContext}`,
      'rest-database-id-unavailable': `A proven numeric REST database id is required for ${boundedContext}`,
    };
    super(messages[code] || `GitHub comment identity validation failed for ${boundedContext}`);
    this.name = 'CommentIdentityError';
    this.code = code;
    this.context = boundedContext;
  }
}

function positiveDatabaseId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function commentDatabaseIdFromUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/[#/]issuecomment-([1-9][0-9]*)(?:$|[/?#])/);
  return match ? positiveDatabaseId(match[1]) : null;
}

function commentNodeId(value) {
  if (typeof value !== 'string') return null;
  const nodeId = value.trim();
  return /^IC_[A-Za-z0-9_-]+$/.test(nodeId) ? nodeId : null;
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null))];
}

/**
 * The only boundary that interprets GraphQL, REST, persisted, and canonical
 * comment representations. Generic `id` is accepted only after its type is
 * proven by value shape: `IC_...` is a GraphQL node id; a positive integer is
 * a REST database id. URLs prove a database id only through `issuecomment-N`.
 *
 * @param {unknown} input
 * @param {{ context?: string, required?: boolean }} [options]
 * @returns {CommentIdentity|null}
 */
export function normalizeCommentIdentity(input, { context = 'comment', required = false } = {}) {
  if (input == null || input === '') {
    if (required) throw new CommentIdentityError('identity-unavailable', context);
    return null;
  }

  if (typeof input === 'string') {
    const value = input.trim();
    const databaseRevision = value.match(/^github-comment:database:([1-9][0-9]*)$/);
    const nodeRevision = value.match(/^github-comment:node:(IC_[A-Za-z0-9_-]+)$/);
    input = databaseRevision
      ? { databaseId: databaseRevision[1] }
      : nodeRevision
        ? { nodeId: nodeRevision[1] }
        : { id: value, url: value };
  } else if (typeof input === 'number') {
    input = { id: input };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    if (required) throw new CommentIdentityError('identity-unavailable', context);
    return null;
  }

  const value = /** @type {Record<string, unknown>} */ (input);
  if (value.version != null && value.version !== COMMENT_IDENTITY_VERSION) {
    throw new CommentIdentityError('identity-version-unsupported', context);
  }
  const nestedIdentity = value.commentIdentity && value.commentIdentity !== value
    ? normalizeCommentIdentity(value.commentIdentity, { context })
    : null;

  const nodeIds = unique([
    nestedIdentity?.nodeId,
    commentNodeId(value.nodeId),
    commentNodeId(value.node_id),
    commentNodeId(value.id),
  ]);
  const databaseIds = unique([
    nestedIdentity?.databaseId,
    positiveDatabaseId(value.databaseId),
    positiveDatabaseId(value.database_id),
    positiveDatabaseId(value.id),
    commentDatabaseIdFromUrl(value.url),
    commentDatabaseIdFromUrl(value.html_url),
  ]);

  if (nodeIds.length > 1 || databaseIds.length > 1) {
    throw new CommentIdentityError('identity-conflict', context);
  }
  if (nodeIds.length === 0 && databaseIds.length === 0) {
    if (required) throw new CommentIdentityError('identity-unavailable', context);
    return null;
  }

  return Object.freeze({
    version: COMMENT_IDENTITY_VERSION,
    nodeId: nodeIds[0] || null,
    databaseId: databaseIds[0] || null,
  });
}

/** @param {unknown} input */
export function commentRevision(input) {
  const identity = normalizeCommentIdentity(input);
  if (!identity) return null;
  return identity.databaseId !== null
    ? `github-comment:database:${identity.databaseId}`
    : `github-comment:node:${identity.nodeId}`;
}

/** @param {unknown} left @param {unknown} right */
export function sameCommentIdentity(left, right) {
  const leftIdentity = normalizeCommentIdentity(left);
  const rightIdentity = normalizeCommentIdentity(right);
  if (!leftIdentity || !rightIdentity) return false;
  if (leftIdentity.databaseId !== null && rightIdentity.databaseId !== null
    && leftIdentity.databaseId !== rightIdentity.databaseId) return false;
  if (leftIdentity.nodeId !== null && rightIdentity.nodeId !== null
    && leftIdentity.nodeId !== rightIdentity.nodeId) return false;
  return (leftIdentity.databaseId !== null && rightIdentity.databaseId !== null)
    || (leftIdentity.nodeId !== null && rightIdentity.nodeId !== null);
}

/** @param {unknown} input @param {string} [context] */
export function requireRestCommentDatabaseId(input, context = 'REST-comment-mutation') {
  const identity = normalizeCommentIdentity(input, { context });
  if (!identity || identity.databaseId === null) {
    throw new CommentIdentityError('rest-database-id-unavailable', context);
  }
  return identity.databaseId;
}

/** @param {unknown} input */
export function serializeCommentIdentity(input) {
  const identity = normalizeCommentIdentity(input);
  return identity ? JSON.stringify(identity) : null;
}

/** @param {unknown} input @param {string} [context] */
export function deserializeCommentIdentity(input, context = 'persisted-comment') {
  if (input == null || input === '') return null;
  if (typeof input !== 'string') return normalizeCommentIdentity(input, { context });
  try {
    return normalizeCommentIdentity(JSON.parse(input), { context });
  } catch (error) {
    if (error instanceof CommentIdentityError) throw error;
    return normalizeCommentIdentity(input, { context });
  }
}
