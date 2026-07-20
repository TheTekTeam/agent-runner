#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = '/home/gp/projects/modelspend';
const MANIFEST_PATH = join(REPO_ROOT, 'MIGRATION-MANIFEST.json');

const CANONICAL_ENTRYPOINTS = [
  '.agent-runner/scripts/runner.mjs',
  '.agent-runner/scripts/runner-cron.mjs',
  '.agent-runner/scripts/github-manager.mjs',
  '.agent-runner/scripts/quota.mjs',
  'scripts/ops/claude-runner.mjs',
  'scripts/ops/claude-runner-cron.mjs',
  'scripts/ops/claude-runner-candidate-probe.mjs',
  'scripts/ops/claude-runner-dashboard-api.mjs',
  'scripts/ops/claude-runner-dashboard-local.mjs',
  'scripts/ops/claude-runner-state-doctor.mjs',
];

const ALLOWED_NON_RELATIVE_IMPORTS = new Set([
  'node:assert',
  'node:assert/strict',
  'node:child_process',
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:os',
  'node:path',
  'node:readline',
  'node:sqlite',
  'node:test',
  'node:url',
  'node:util',
]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE,
    write: false,
    replace: false,
    verifyOnly: false,
    expectedCommit: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') args.source = argv[++index];
    else if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length);
    else if (arg === '--write') args.write = true;
    else if (arg === '--replace') args.replace = true;
    else if (arg === '--verify-only') args.verifyOnly = true;
    else if (arg === '--expected-commit') args.expectedCommit = argv[++index];
    else if (arg.startsWith('--expected-commit=')) args.expectedCommit = arg.slice('--expected-commit='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/import-modelspend-runner.mjs [options]\n\nOptions:\n  --source <path>          ModelSpend source checkout\n  --write                  Copy the computed runner closure into this repository\n  --replace                Permit replacement of previously imported runner files\n  --verify-only            Verify the existing manifest/files against the source\n  --expected-commit <sha>  Require an exact ModelSpend source commit\n`);
      process.exit(0);
    } else fail(`Unknown option: ${arg}`);
  }
  if (args.write && args.verifyOnly) fail('--write and --verify-only are mutually exclusive');
  return args;
}

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sourceRelative(sourceRoot, absolutePath) {
  const result = relative(sourceRoot, absolutePath).split(sep).join('/');
  if (!result || result === '..' || result.startsWith('../') || isAbsolute(result)) {
    fail(`Resolved dependency escapes the ModelSpend checkout: ${absolutePath}`);
  }
  return result;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function trackedFiles(sourceRoot) {
  return runGit(sourceRoot, ['ls-files', '-z']).split('\0').filter(Boolean);
}

function initialSelection(files) {
  const selected = new Set(CANONICAL_ENTRYPOINTS);
  for (const path of files) {
    if (path.startsWith('.agent-runner/')) {
      if (path.endsWith('/config.json') || path.endsWith('/dashboard-data.js')) continue;
      selected.add(path);
      continue;
    }
    if (/^scripts\/ops\/(?:agent-runner|claude-runner)[^/]*\.(?:mjs|sh)$/.test(path)) selected.add(path);
    if (/^scripts\/ops\/(?:agent-runner|claude-runner)[^/]*\.test\.mjs$/.test(path)) selected.add(path);
    if (path === 'scripts/ops/jobs/run-claude-runner.sh') selected.add(path);
    if (/^scripts\/ops\/install-claude-runner[^/]*\.(?:sh|mjs)$/.test(path)) selected.add(path);
    if (/^docs\/ops\/(?:AGENT-RUNNER|CLAUDE-RUNNER)[^/]*\.md$/.test(path)) selected.add(path);
  }
  return selected;
}

function importSpecifiers(text) {
  const specs = [];
  const patterns = [
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

function resolveRelativeImport(sourceRoot, importer, specifier) {
  const base = resolve(sourceRoot, dirname(importer), specifier);
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.mjs`, `${base}.js`, `${base}.json`, join(base, 'index.mjs'), join(base, 'index.js')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return sourceRelative(sourceRoot, realpathSync(candidate));
  }
  fail(`Unable to resolve ${specifier} imported by ${importer}`);
}

function dependencyClosure(sourceRoot, initial) {
  const selected = new Set(initial);
  const queue = [...selected];
  const unsupportedImports = new Map();

  while (queue.length > 0) {
    const path = queue.shift();
    const absolute = join(sourceRoot, path);
    if (!existsSync(absolute)) fail(`Required source file is missing: ${path}`);
    if (!/\.(?:mjs|js)$/.test(path)) continue;
    const text = readFileSync(absolute, 'utf8');
    for (const specifier of importSpecifiers(text)) {
      if (specifier.startsWith('.')) {
        const dependency = resolveRelativeImport(sourceRoot, path, specifier);
        if (!selected.has(dependency)) {
          selected.add(dependency);
          queue.push(dependency);
        }
      } else if (!ALLOWED_NON_RELATIVE_IMPORTS.has(specifier)) {
        const importers = unsupportedImports.get(specifier) || [];
        importers.push(path);
        unsupportedImports.set(specifier, importers);
      }
    }
  }

  if (unsupportedImports.size > 0) {
    const details = [...unsupportedImports.entries()]
      .map(([specifier, importers]) => `${specifier}: ${importers.join(', ')}`)
      .join('\n');
    fail(`The runner closure contains undeclared external imports. Add an explicit reviewed dependency before extraction:\n${details}`);
  }

  return [...selected].sort();
}

function validateSource(sourceRoot, expectedCommit) {
  if (!existsSync(join(sourceRoot, '.git'))) fail(`Not a Git checkout: ${sourceRoot}`);
  const remote = runGit(sourceRoot, ['remote', 'get-url', 'origin']);
  if (!/TheTekTeam\/modelspend(?:\.git)?$/.test(remote)) fail(`Unexpected source origin: ${remote}`);
  const commit = runGit(sourceRoot, ['rev-parse', 'HEAD']);
  if (expectedCommit && commit !== expectedCommit) fail(`Source commit ${commit} does not match required ${expectedCommit}`);
  const status = runGit(sourceRoot, ['status', '--porcelain']);
  if (status) fail('ModelSpend source checkout is dirty; extraction requires a clean, reviewable commit');
  return { remote, commit };
}

function buildManifest(sourceRoot, source, files) {
  return {
    schemaVersion: 1,
    sourceRepository: 'TheTekTeam/modelspend',
    sourceRemote: source.remote,
    sourceCommit: source.commit,
    importedAt: new Date().toISOString(),
    canonicalEntrypoints: CANONICAL_ENTRYPOINTS,
    files: files.map((path) => ({ path, sha256: sha256(join(sourceRoot, path)) })),
  };
}

function verifyManifest(sourceRoot) {
  if (!existsSync(MANIFEST_PATH)) fail('MIGRATION-MANIFEST.json does not exist');
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const problems = [];
  for (const item of manifest.files || []) {
    const destination = join(REPO_ROOT, item.path);
    const source = join(sourceRoot, item.path);
    if (!existsSync(destination)) problems.push(`missing destination: ${item.path}`);
    else if (sha256(destination) !== item.sha256) problems.push(`destination drift: ${item.path}`);
    if (!existsSync(source)) problems.push(`missing source: ${item.path}`);
    else if (sha256(source) !== item.sha256) problems.push(`source drift since ${manifest.sourceCommit}: ${item.path}`);
  }
  if (problems.length) fail(problems.join('\n'));
  console.log(`PASS: ${manifest.files.length} imported files match ${manifest.sourceCommit}`);
}

function copySelection(sourceRoot, files, { replace }) {
  for (const path of files) {
    const source = join(sourceRoot, path);
    const destination = join(REPO_ROOT, path);
    if (existsSync(destination) && !replace) fail(`Destination exists; repeat with --replace after reviewing drift: ${path}`);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function checkJavaScript(files) {
  for (const path of files.filter((item) => /\.(?:mjs|js)$/.test(item))) {
    execFileSync(process.execPath, ['--check', join(REPO_ROOT, path)], { stdio: 'inherit' });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = realpathSync(resolve(args.source));
  const source = validateSource(sourceRoot, args.expectedCommit);

  if (args.verifyOnly) {
    verifyManifest(sourceRoot);
    return;
  }

  const files = dependencyClosure(sourceRoot, initialSelection(trackedFiles(sourceRoot)));
  const manifest = buildManifest(sourceRoot, source, files);

  console.log(`Source commit: ${source.commit}`);
  console.log(`Runner closure: ${files.length} tracked files`);
  for (const path of files) console.log(path);

  if (!args.write) {
    console.log('Dry run only. Repeat with --write to copy the reviewed closure.');
    return;
  }

  copySelection(sourceRoot, files, { replace: args.replace });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  checkJavaScript(files);
  verifyManifest(sourceRoot);
  console.log('PASS: standalone runner source imported with provenance manifest');
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message || error}`);
  process.exitCode = 1;
}
