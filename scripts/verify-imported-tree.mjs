#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'MIGRATION-MANIFEST.json');
if (!existsSync(manifestPath)) {
  console.log('INFO: no migration manifest yet; source import has not been committed');
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];
for (const item of manifest.files || []) {
  const path = join(root, item.path);
  if (!existsSync(path)) {
    errors.push(`missing: ${item.path}`);
    continue;
  }
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== item.sha256) errors.push(`hash mismatch: ${item.path}`);
}
if (!manifest.sourceCommit || !Array.isArray(manifest.files) || manifest.files.length === 0) {
  errors.push('manifest has no source commit or imported files');
}
if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}
console.log(`PASS: ${manifest.files.length} imported files match manifest source ${manifest.sourceCommit}`);
