// Status-aware validation for MIGRATION-MANIFEST.json `files` entries.
//
// Every imported file starts "locked": byte-identical to the ModelSpend
// commit it was extracted from, enforced by an exact sha256 match. Once
// canonical ownership of a file has genuinely moved to this repository --
// because the bug being fixed lives inside that file and cannot be
// corrected while it stays byte-locked to the historical import (see #686 /
// PR #19) -- the manifest can instead record it as "transferred": its
// provenance (where it came from) and ownership (why/when it stopped being
// locked) are preserved, but its content is free to diverge going forward.
//
// This module is deliberately independent of any specific list of
// filenames: scripts/verify-imported-tree.mjs and any future migration
// tooling derive locked/transferred purely from each entry's own `status`
// field, never from a hardcoded path list.

export const MANIFEST_STATUS_LOCKED = 'locked';
export const MANIFEST_STATUS_TRANSFERRED = 'transferred';
const VALID_STATUSES = new Set([MANIFEST_STATUS_LOCKED, MANIFEST_STATUS_TRANSFERRED]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Shape-check a transferred entry's provenance/ownership record. Returns a
 * list of problems; empty means well-formed. Never touches the filesystem.
 */
export function transferRecordProblems(entry = {}) {
  const problems = [];
  const { provenance, ownership } = entry;

  if (!isPlainObject(provenance)) {
    problems.push('missing provenance');
  } else {
    if (!nonEmptyString(provenance.sourceRepository)) problems.push('provenance.sourceRepository');
    if (!nonEmptyString(provenance.sourceCommit)) problems.push('provenance.sourceCommit');
    if (!isSha256Hex(provenance.importedSha256)) problems.push('provenance.importedSha256');
  }

  if (!isPlainObject(ownership)) {
    problems.push('missing ownership');
  } else {
    if (!nonEmptyString(ownership.canonicalRepository)) problems.push('ownership.canonicalRepository');
    if (!nonEmptyString(ownership.transferredAt) || Number.isNaN(Date.parse(ownership.transferredAt))) problems.push('ownership.transferredAt');
    if (!nonEmptyString(ownership.reference)) problems.push('ownership.reference');
  }

  return problems;
}

/**
 * Evaluate every entry of a MIGRATION-MANIFEST.json `files` array. Status
 * absent is treated as "locked" (the original, single-status manifest
 * shape) -- the strict, fail-closed default; only an explicit, recognized
 * "transferred" status relaxes the hash check, and any other status value
 * is rejected outright. A transferred entry must still exist and carry a
 * well-formed provenance/ownership record; only its hash is not enforced.
 *
 * fileExists/sha256OfFile are injected so this stays pure/testable without
 * touching a real checkout; the CLI wrapper backs them with node:fs.
 */
export function evaluateManifestFiles(files = [], { fileExists, sha256OfFile }) {
  const errors = [];
  const locked = [];
  const transferred = [];
  const invalid = [];

  for (const entry of Array.isArray(files) ? files : []) {
    const path = entry?.path;
    if (!nonEmptyString(path)) {
      errors.push(`manifest entry missing a path: ${JSON.stringify(entry)}`);
      invalid.push(path ?? null);
      continue;
    }

    const status = entry.status === undefined ? MANIFEST_STATUS_LOCKED : entry.status;
    if (!VALID_STATUSES.has(status)) {
      errors.push(`unknown status "${entry.status}" for ${path}`);
      invalid.push(path);
      continue;
    }

    if (!fileExists(path)) {
      errors.push(`missing: ${path}`);
      invalid.push(path);
      continue;
    }

    if (status === MANIFEST_STATUS_LOCKED) {
      if (!isSha256Hex(entry.sha256)) {
        errors.push(`locked entry has no recorded sha256: ${path}`);
        invalid.push(path);
        continue;
      }
      const digest = sha256OfFile(path);
      if (digest !== entry.sha256) {
        errors.push(`hash mismatch: ${path}`);
        invalid.push(path);
        continue;
      }
      locked.push(path);
      continue;
    }

    const problems = transferRecordProblems(entry);
    if (problems.length) {
      errors.push(`malformed transfer record for ${path}: ${problems.join(', ')}`);
      invalid.push(path);
      continue;
    }
    transferred.push(path);
  }

  return { errors, locked, transferred, invalid };
}
