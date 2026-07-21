#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateManifestFiles } from './ops/agent-runner-manifest-provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'MIGRATION-MANIFEST.json');
const ownershipPath = join(root, 'CANONICAL-OWNERSHIP.json');
if (!existsSync(manifestPath)) {
  console.log('INFO: no migration manifest yet; source import has not been committed');
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const ownership = existsSync(ownershipPath)
  ? JSON.parse(readFileSync(ownershipPath, 'utf8'))
  : { transfers: [] };
const transfers = new Map((ownership.transfers || []).map((entry) => [entry.path, entry]));
const effectiveFiles = (manifest.files || []).map((entry) => {
  const transfer = transfers.get(entry.path);
  if (!transfer) return entry;
  return {
    path: entry.path,
    mode: entry.mode,
    status: 'transferred',
    provenance: {
      sourceRepository: manifest.sourceRepository,
      sourceCommit: manifest.sourceCommit,
      importedSha256: entry.sha256 || entry.provenance?.importedSha256,
    },
    ownership: transfer.ownership,
  };
});

const result = evaluateManifestFiles(effectiveFiles, {
  fileExists: (path) => existsSync(join(root, path)),
  sha256OfFile: (path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
});

const errors = [...result.errors];
if (!manifest.sourceCommit || !Array.isArray(manifest.files) || manifest.files.length === 0) {
  errors.push('manifest has no source commit or imported files');
}
for (const path of transfers.keys()) {
  if (!(manifest.files || []).some((entry) => entry.path === path)) {
    errors.push(`canonical ownership transfer is not present in migration manifest: ${path}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`PASS: ${result.locked.length} locked imported file(s) match manifest source ${manifest.sourceCommit}`);
if (result.transferred.length > 0) {
  console.log(`PASS: ${result.transferred.length} file(s) intentionally transferred to canonical ownership outside the ModelSpend import lock:`);
  for (const path of result.transferred) console.log(`  - ${path}`);
}
