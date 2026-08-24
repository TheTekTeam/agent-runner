import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const REPOSITORY_MAP_SCHEMA_VERSION = 1;
export const REPOSITORY_MAP_TOOL_VERSION = 'repository-map-v1';
export const DEFAULT_REPOSITORY_MAP_LIMITS = Object.freeze({
  maxFiles: 4096,
  maxDepth: 24,
  maxQueryItems: 24,
  maxQueryBytes: 16 * 1024,
  maxMapBytes: 512 * 1024,
  maxParsedTextBytes: 512 * 1024,
  maxDependencyEdgesPerFile: 24,
});

const SKIPPED_DIRECTORIES = new Map([
  ['.git', 'vcs-metadata'],
  ['node_modules', 'dependencies'],
  ['vendor', 'dependencies'],
  ['.venv', 'dependencies'],
  ['venv', 'dependencies'],
  ['__pycache__', 'generated'],
  ['dist', 'generated'],
  ['build', 'generated'],
  ['coverage', 'generated'],
  ['.next', 'generated'],
  ['.turbo', 'generated'],
  ['target', 'generated'],
  ['out', 'generated'],
  ['.cache', 'generated'],
]);

const CONFIG_BASENAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'deno.json',
  'deno.jsonc',
  'tsconfig.json',
  'jsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'poetry.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'Gemfile',
  'Gemfile.lock',
  'Makefile',
]);

const INSTRUCTION_BASENAMES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'copilot-instructions.md',
]);

const LANGUAGE_BY_EXTENSION = new Map([
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'], ['.tsx', 'typescript'],
  ['.py', 'python'], ['.go', 'go'], ['.rs', 'rust'], ['.rb', 'ruby'], ['.java', 'java'],
  ['.kt', 'kotlin'], ['.kts', 'kotlin'], ['.cs', 'csharp'], ['.php', 'php'], ['.sh', 'shell'],
  ['.bash', 'shell'], ['.zsh', 'shell'], ['.sql', 'sql'], ['.vue', 'vue'], ['.svelte', 'svelte'],
]);

const TEXT_DEPENDENCY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx']);
const SOURCE_CANDIDATE_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json'];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value));
  return createHash('sha256').update(bytes).digest('hex');
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeRelativePath(value, name = 'path') {
  if (!nonEmptyString(value)) throw new Error(`${name} is required`);
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (isAbsolute(value) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.includes('\0')) {
    throw new Error(`${name} must be repository-relative`);
  }
  return normalized;
}

function safeToken(value, name) {
  if (!nonEmptyString(value) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function normalizeProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('project is required');
  const projectId = safeToken(project.projectId, 'projectId');
  const githubRepo = nonEmptyString(project.githubRepo) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.githubRepo)
    ? project.githubRepo
    : null;
  if (!githubRepo) throw new Error('githubRepo is invalid');
  return Object.freeze({ projectId, githubRepo });
}

function runGit(repositoryRoot, args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer,
    }).trimEnd();
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    throw new Error(`repository map git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function assertRepositoryRoot(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const topLevel = resolve(runGit(root, ['rev-parse', '--show-toplevel']));
  if (topLevel !== root) throw new Error(`repositoryRoot must be the exact git worktree root: ${root}`);
  return root;
}

function parseStatusPaths(statusText) {
  if (!statusText) return [];
  const parts = statusText.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = safeRelativePath(entry.slice(3), 'dirty path');
    paths.push(path);
    if (/[RC]/.test(status) && parts[index + 1]) index += 1;
  }
  return [...new Set(paths)].sort();
}

function gitObjectHash(repositoryRoot, relativePath) {
  const absolute = resolve(repositoryRoot, relativePath);
  const rel = relative(repositoryRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('dirty path escaped repository root');
  if (!existsSync(absolute)) return 'deleted';
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) return `symlink:${digest(readFileSync(absolute, { encoding: 'utf8', flag: 'r' }))}`;
  if (!stat.isFile()) return `non-file:${stat.mode}`;
  return runGit(repositoryRoot, ['hash-object', '--no-filters', '--', relativePath], { maxBuffer: 1024 * 1024 });
}

export function captureRepositorySourceIdentity({ repositoryRoot }) {
  const root = assertRepositoryRoot(repositoryRoot);
  const headSha = runGit(root, ['rev-parse', 'HEAD']);
  const treeSha = runGit(root, ['rev-parse', 'HEAD^{tree}']);
  if (!/^[a-f0-9]{40,64}$/i.test(headSha) || !/^[a-f0-9]{40,64}$/i.test(treeSha)) {
    throw new Error('repository source identity returned an invalid SHA');
  }
  const statusText = execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
  const dirtyPaths = parseStatusPaths(statusText);
  const dirtyEntries = dirtyPaths.map((path) => ({ path, objectHash: gitObjectHash(root, path) }));
  const dirtyFingerprint = dirtyEntries.length === 0 ? 'clean' : `sha256:${digest(dirtyEntries)}`;
  const sourceFingerprint = `sha256:${digest({ headSha: headSha.toLowerCase(), treeSha: treeSha.toLowerCase(), dirtyEntries })}`;
  return Object.freeze({
    headSha: headSha.toLowerCase(),
    treeSha: treeSha.toLowerCase(),
    dirty: dirtyEntries.length > 0,
    dirtyFingerprint,
    sourceFingerprint,
  });
}

function classifyLanguage(path) {
  return LANGUAGE_BY_EXTENSION.get(extname(path).toLowerCase()) || null;
}

function listRepositoryFiles(repositoryRoot, limits) {
  const files = [];
  const excludedAreas = [];
  let truncated = false;

  function walk(absoluteDir, relativeDir, depth) {
    if (truncated || depth > limits.maxDepth) {
      if (depth > limits.maxDepth) excludedAreas.push({ path: relativeDir || '.', reason: 'depth-limit' });
      return;
    }
    const entries = readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) break;
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        excludedAreas.push({ path: rel, reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        const skippedReason = SKIPPED_DIRECTORIES.get(entry.name);
        if (skippedReason) {
          excludedAreas.push({ path: rel, reason: skippedReason });
          continue;
        }
        walk(join(absoluteDir, entry.name), rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= limits.maxFiles) {
        truncated = true;
        excludedAreas.push({ path: rel, reason: 'file-limit' });
        break;
      }
      files.push(rel);
    }
  }

  walk(repositoryRoot, '', 0);
  return { files, excludedAreas, truncated };
}

function readBoundedText(repositoryRoot, path, maxBytes) {
  const absolute = resolve(repositoryRoot, path);
  const rel = relative(repositoryRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size > maxBytes) return null;
  const value = readFileSync(absolute);
  if (value.includes(0)) return null;
  return value.toString('utf8');
}

function configFingerprint(repositoryRoot, files, maxBytes) {
  const configEntries = files
    .filter((path) => CONFIG_BASENAMES.has(basename(path)))
    .sort()
    .map((path) => {
      const text = readBoundedText(repositoryRoot, path, maxBytes);
      return { path, digest: text === null ? 'unreadable-or-large' : `sha256:${digest(text)}` };
    });
  return `sha256:${digest(configEntries)}`;
}

function normalizeWorkspacePatterns(value) {
  if (Array.isArray(value)) return value.filter(nonEmptyString).slice(0, 64);
  if (value && typeof value === 'object' && Array.isArray(value.packages)) {
    return value.packages.filter(nonEmptyString).slice(0, 64);
  }
  return [];
}

function collectEntrypoints(manifest) {
  const result = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.length <= 500 && !value.includes('://')) {
      const clean = value.replace(/^\.\//, '');
      if (clean && !clean.startsWith('/') && !clean.includes('..')) result.add(clean);
    }
  };
  add(manifest.main);
  add(manifest.module);
  add(manifest.types);
  if (typeof manifest.bin === 'string') add(manifest.bin);
  else if (manifest.bin && typeof manifest.bin === 'object') Object.values(manifest.bin).forEach(add);
  if (typeof manifest.exports === 'string') add(manifest.exports);
  else if (manifest.exports && typeof manifest.exports === 'object') {
    const visit = (value, depth = 0) => {
      if (depth > 4) return;
      if (typeof value === 'string') add(value);
      else if (value && typeof value === 'object') Object.values(value).forEach((item) => visit(item, depth + 1));
    };
    visit(manifest.exports);
  }
  return [...result].sort().slice(0, 64);
}

function packageBoundaries(repositoryRoot, files, maxBytes) {
  const packages = [];
  for (const path of files.filter((file) => basename(file) === 'package.json').sort()) {
    const text = readBoundedText(repositoryRoot, path, maxBytes);
    if (text === null) continue;
    try {
      const manifest = JSON.parse(text);
      packages.push({
        path,
        root: dirname(path) === '.' ? '.' : dirname(path).replaceAll('\\', '/'),
        name: nonEmptyString(manifest.name) ? manifest.name.slice(0, 200) : null,
        packageType: nonEmptyString(manifest.type) ? manifest.type.slice(0, 32) : null,
        workspacePatterns: normalizeWorkspacePatterns(manifest.workspaces),
        entrypoints: collectEntrypoints(manifest),
      });
    } catch {
      packages.push({ path, root: dirname(path) === '.' ? '.' : dirname(path).replaceAll('\\', '/'), name: null, packageType: null, workspacePatterns: [], entrypoints: [], invalidManifest: true });
    }
  }
  return packages;
}

function instructionPaths(files) {
  return files
    .filter((path) => INSTRUCTION_BASENAMES.has(basename(path)) || path === '.github/copilot-instructions.md' || path.startsWith('.cursor/rules/'))
    .sort()
    .slice(0, 128)
    .map((path) => ({ path, scope: dirname(path) === '.' ? '.' : dirname(path).replaceAll('\\', '/') }));
}

function languageSummary(files) {
  const counts = new Map();
  for (const path of files) {
    const language = classifyLanguage(path);
    if (language) counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 16)
    .map(([language, filesCount]) => ({ language, files: filesCount }));
}

function toolingSummary(files) {
  const names = new Set(files.map((path) => basename(path)));
  const tooling = [];
  if (names.has('package.json')) tooling.push('node');
  if (names.has('pnpm-lock.yaml') || names.has('pnpm-workspace.yaml')) tooling.push('pnpm');
  if (names.has('package-lock.json')) tooling.push('npm');
  if (names.has('yarn.lock')) tooling.push('yarn');
  if (names.has('pyproject.toml') || names.has('requirements.txt')) tooling.push('python');
  if (names.has('Cargo.toml')) tooling.push('cargo');
  if (names.has('go.mod')) tooling.push('go');
  return tooling.sort();
}

function resolveRelativeDependency(sourcePath, specifier, fileSet) {
  if (!specifier.startsWith('.')) return null;
  const sourceDir = dirname(sourcePath);
  const base = join(sourceDir, specifier).replaceAll('\\', '/');
  for (const extension of SOURCE_CANDIDATE_EXTENSIONS) {
    const candidate = `${base}${extension}`.replace(/^\.\//, '');
    if (fileSet.has(candidate)) return candidate;
  }
  for (const extension of SOURCE_CANDIDATE_EXTENSIONS.slice(1)) {
    const candidate = `${base}/index${extension}`.replace(/^\.\//, '');
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function dependencyEdges(repositoryRoot, files, limits) {
  const fileSet = new Set(files);
  const edges = [];
  const importPattern = /(?:\bimport\s+(?:[^'";]+?\s+from\s+)?|\bexport\s+[^'";]+?\s+from\s+|\brequire\s*\()\s*['"]([^'"]+)['"]/g;
  for (const source of files) {
    if (!TEXT_DEPENDENCY_EXTENSIONS.has(extname(source).toLowerCase())) continue;
    const text = readBoundedText(repositoryRoot, source, limits.maxParsedTextBytes);
    if (text === null) continue;
    const targets = new Set();
    for (const match of text.matchAll(importPattern)) {
      const target = resolveRelativeDependency(source, match[1], fileSet);
      if (target) targets.add(target);
      if (targets.size >= limits.maxDependencyEdgesPerFile) break;
    }
    for (const target of [...targets].sort()) edges.push({ source, target });
  }
  return edges;
}

function finalMapDigest(map) {
  const withoutDigest = { ...map };
  delete withoutDigest.mapDigest;
  return `sha256:${digest(withoutDigest)}`;
}

export function buildRepositoryMap({ project, repositoryRoot, sourceIdentity = null, limits = {} }) {
  const normalizedProject = normalizeProject(project);
  const root = assertRepositoryRoot(repositoryRoot);
  const effectiveLimits = { ...DEFAULT_REPOSITORY_MAP_LIMITS, ...limits };
  const source = sourceIdentity || captureRepositorySourceIdentity({ repositoryRoot: root });
  const { files, excludedAreas, truncated } = listRepositoryFiles(root, effectiveLimits);
  const configDigest = configFingerprint(root, files, effectiveLimits.maxParsedTextBytes);
  const map = {
    schemaVersion: REPOSITORY_MAP_SCHEMA_VERSION,
    toolVersion: REPOSITORY_MAP_TOOL_VERSION,
    project: normalizedProject,
    source,
    configFingerprint: configDigest,
    truncated,
    files,
    excludedAreas: excludedAreas.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 512),
    languages: languageSummary(files),
    tooling: toolingSummary(files),
    packages: packageBoundaries(root, files, effectiveLimits.maxParsedTextBytes),
    instructions: instructionPaths(files),
    dependencies: dependencyEdges(root, files, effectiveLimits),
  };
  map.mapDigest = finalMapDigest(map);
  const serialized = JSON.stringify(map);
  if (Buffer.byteLength(serialized) > effectiveLimits.maxMapBytes) {
    throw new Error(`repository map exceeds ${effectiveLimits.maxMapBytes} byte bound`);
  }
  return Object.freeze(map);
}

function namespaceForProject(project) {
  const normalized = normalizeProject(project);
  const slug = normalized.projectId.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${slug}-${digest(normalized.githubRepo.toLowerCase()).slice(0, 12)}`;
}

export function defaultRepositoryMapCacheRoot(env = process.env) {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  return resolve(base, 'agent-runner', 'repository-map');
}

function ensureSafeDirectory(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`repository map cache path is unsafe: ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function cacheFilePath({ cacheRoot, project, sourceIdentity, configFingerprint: configDigest }) {
  const namespace = namespaceForProject(project);
  const sourceKey = sourceIdentity.sourceFingerprint.replace('sha256:', '');
  const configKey = configDigest.replace('sha256:', '');
  return join(cacheRoot, namespace, `v${REPOSITORY_MAP_SCHEMA_VERSION}-${sourceKey}-${configKey}.json`);
}

function validateLoadedMap(map, { project, sourceIdentity, configFingerprint: configDigest }) {
  const normalized = normalizeProject(project);
  if (!map || map.schemaVersion !== REPOSITORY_MAP_SCHEMA_VERSION || map.toolVersion !== REPOSITORY_MAP_TOOL_VERSION) return false;
  if (map.project?.projectId !== normalized.projectId || String(map.project?.githubRepo).toLowerCase() !== normalized.githubRepo.toLowerCase()) return false;
  if (map.source?.sourceFingerprint !== sourceIdentity.sourceFingerprint || map.source?.headSha !== sourceIdentity.headSha || map.source?.treeSha !== sourceIdentity.treeSha) return false;
  if (map.configFingerprint !== configDigest) return false;
  if (!/^sha256:[a-f0-9]{64}$/.test(map.mapDigest || '') || map.mapDigest !== finalMapDigest(map)) return false;
  return true;
}

function currentConfigFingerprint(repositoryRoot, limits) {
  const root = assertRepositoryRoot(repositoryRoot);
  const { files } = listRepositoryFiles(root, limits);
  return configFingerprint(root, files, limits.maxParsedTextBytes);
}

export function loadOrBuildRepositoryMap({ project, repositoryRoot, cacheRoot = defaultRepositoryMapCacheRoot(), limits = {} }) {
  const normalizedProject = normalizeProject(project);
  const root = assertRepositoryRoot(repositoryRoot);
  const effectiveLimits = { ...DEFAULT_REPOSITORY_MAP_LIMITS, ...limits };
  const sourceIdentity = captureRepositorySourceIdentity({ repositoryRoot: root });
  const configDigest = currentConfigFingerprint(root, effectiveLimits);
  const rootPath = resolve(cacheRoot);
  ensureSafeDirectory(rootPath);
  const namespacePath = join(rootPath, namespaceForProject(normalizedProject));
  ensureSafeDirectory(namespacePath);
  const path = cacheFilePath({ cacheRoot: rootPath, project: normalizedProject, sourceIdentity, configFingerprint: configDigest });
  if (existsSync(path)) {
    try {
      const candidate = JSON.parse(readFileSync(path, 'utf8'));
      if (validateLoadedMap(candidate, { project: normalizedProject, sourceIdentity, configFingerprint: configDigest })) {
        return Object.freeze({ map: Object.freeze(candidate), reused: true, cachePath: path });
      }
    } catch {
      // Corruption is an efficiency failure only. Rebuild from exact current source.
    }
    rmSync(path, { force: true });
  }
  const map = buildRepositoryMap({ project: normalizedProject, repositoryRoot: root, sourceIdentity, limits: effectiveLimits });
  if (map.configFingerprint !== configDigest) throw new Error('repository configuration changed while repository map was being built');
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(map)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return Object.freeze({ map, reused: false, cachePath: path });
}

export function assertRepositoryMapIdentity(map, expected) {
  const expectedProjectId = safeToken(expected?.projectId, 'expected projectId');
  const expectedRepo = nonEmptyString(expected?.githubRepo) ? expected.githubRepo.toLowerCase() : null;
  const expectedFingerprint = expected?.sourceFingerprint;
  if (map?.project?.projectId !== expectedProjectId) throw new Error('repository map project identity mismatch');
  if (!expectedRepo || String(map?.project?.githubRepo || '').toLowerCase() !== expectedRepo) throw new Error('repository map repository identity mismatch');
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedFingerprint || '') || map?.source?.sourceFingerprint !== expectedFingerprint) {
    throw new Error('repository map source fingerprint mismatch');
  }
  if (map?.mapDigest !== finalMapDigest(map)) throw new Error('repository map digest mismatch');
  return true;
}

function packageForPath(map, path) {
  const normalized = safeRelativePath(path);
  const matches = (map.packages || []).filter((pkg) => pkg.root === '.' || normalized === pkg.root || normalized.startsWith(`${pkg.root}/`));
  matches.sort((a, b) => b.root.length - a.root.length);
  return matches[0] || null;
}

function likelyTests(map, path) {
  const normalized = safeRelativePath(path);
  const files = map.files || [];
  const extension = extname(normalized);
  const stem = normalized.slice(0, normalized.length - extension.length);
  const leaf = basename(stem);
  const directory = dirname(normalized).replaceAll('\\', '/');
  const directCandidates = new Set([
    `${stem}.test${extension}`,
    `${stem}.spec${extension}`,
    `${stem}.test.mjs`,
    `${stem}.test.js`,
    `${stem}.test.ts`,
    `${stem}.spec.ts`,
  ]);
  return files.filter((candidate) => {
    if (directCandidates.has(candidate)) return true;
    const candidateLeaf = basename(candidate).toLowerCase();
    return /\.(test|spec)\./i.test(candidateLeaf)
      && candidateLeaf.includes(leaf.toLowerCase())
      && (dirname(candidate).replaceAll('\\', '/') === directory || candidate.includes('/test') || candidate.includes('/__tests__/'));
  });
}

function applicableInstructions(map, path) {
  const normalized = safeRelativePath(path);
  return (map.instructions || []).filter(({ scope }) => scope === '.' || normalized === scope || normalized.startsWith(`${scope}/`));
}

function boundResult(value, { maxItems, maxBytes }) {
  const result = { ...value };
  for (const [key, item] of Object.entries(result)) {
    if (Array.isArray(item)) result[key] = item.slice(0, maxItems);
  }
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
    const arrays = Object.keys(result).filter((key) => Array.isArray(result[key]) && result[key].length > 0);
    if (arrays.length === 0) throw new Error('repository map query scalar result exceeds byte bound');
    arrays.sort((a, b) => result[b].length - result[a].length);
    result[arrays[0]].pop();
    result.truncated = true;
  }
  return Object.freeze(result);
}

export function queryRepositoryMap(map, query = {}, limits = {}) {
  const maxItems = Math.min(Math.max(Number(limits.maxItems || DEFAULT_REPOSITORY_MAP_LIMITS.maxQueryItems), 1), 100);
  const maxBytes = Math.min(Math.max(Number(limits.maxBytes || DEFAULT_REPOSITORY_MAP_LIMITS.maxQueryBytes), 1024), 64 * 1024);
  const kind = query.kind;
  let result;
  if (kind === 'files') {
    const term = String(query.term || '').trim().toLowerCase();
    if (!term || term.length > 200) throw new Error('files query requires a bounded term');
    result = { kind, files: (map.files || []).filter((path) => path.toLowerCase().includes(term)) };
  } else if (kind === 'subtree') {
    const path = safeRelativePath(query.path);
    const prefix = path === '.' ? '' : `${path.replace(/\/$/, '')}/`;
    result = { kind, path, files: (map.files || []).filter((candidate) => candidate === path || candidate.startsWith(prefix)) };
  } else if (kind === 'package') {
    const path = safeRelativePath(query.path);
    result = { kind, path, packages: [packageForPath(map, path)].filter(Boolean) };
  } else if (kind === 'tests') {
    const path = safeRelativePath(query.path);
    result = { kind, path, files: likelyTests(map, path) };
  } else if (kind === 'dependencies') {
    const path = safeRelativePath(query.path);
    result = {
      kind,
      path,
      outgoing: (map.dependencies || []).filter((edge) => edge.source === path),
      incoming: (map.dependencies || []).filter((edge) => edge.target === path),
    };
  } else if (kind === 'instructions') {
    const path = safeRelativePath(query.path);
    result = { kind, path, instructions: applicableInstructions(map, path) };
  } else {
    throw new Error(`unsupported repository map query kind: ${String(kind || '')}`);
  }
  return boundResult({ schemaVersion: 1, sourceFingerprint: map?.source?.sourceFingerprint, ...result, truncated: Boolean(map?.truncated) }, { maxItems, maxBytes });
}

export function buildRepositoryNavigationCapsule(map, { paths = [], terms = [] } = {}, limits = {}) {
  const maxItems = Math.min(Math.max(Number(limits.maxItems || 8), 1), 24);
  const relevant = new Set();
  const tests = new Set();
  const instructions = new Set();
  for (const rawPath of paths.slice(0, maxItems)) {
    const path = safeRelativePath(rawPath);
    if ((map.files || []).includes(path)) relevant.add(path);
    for (const test of likelyTests(map, path)) tests.add(test);
    for (const instruction of applicableInstructions(map, path)) instructions.add(instruction.path);
  }
  for (const rawTerm of terms.slice(0, maxItems)) {
    const term = String(rawTerm || '').trim().toLowerCase();
    if (!term || term.length > 200) continue;
    for (const path of map.files || []) {
      if (path.toLowerCase().includes(term)) relevant.add(path);
      if (relevant.size >= maxItems * 2) break;
    }
  }
  for (const path of [...relevant]) {
    for (const instruction of applicableInstructions(map, path)) instructions.add(instruction.path);
    for (const test of likelyTests(map, path)) tests.add(test);
  }
  return boundResult({
    schemaVersion: 1,
    sourceFingerprint: map.source.sourceFingerprint,
    mapDigest: map.mapDigest,
    files: [...relevant].sort(),
    tests: [...tests].sort(),
    instructions: [...instructions].sort(),
    mapTruncated: Boolean(map.truncated),
    navigationOnly: true,
  }, { maxItems, maxBytes: Math.min(Number(limits.maxBytes || 8 * 1024), 16 * 1024) });
}

export function tryRepositoryNavigationCapsule(options, request, limits = {}) {
  try {
    const loaded = loadOrBuildRepositoryMap(options);
    return Object.freeze({ available: true, reused: loaded.reused, capsule: buildRepositoryNavigationCapsule(loaded.map, request, limits) });
  } catch (error) {
    return Object.freeze({ available: false, reused: false, capsule: null, reason: 'repository-map-unavailable', detail: String(error?.message || error).slice(0, 300) });
  }
}
