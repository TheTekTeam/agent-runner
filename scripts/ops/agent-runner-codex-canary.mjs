#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { admitCodexDispatch, buildCodexCommandArgs, classifyCodexExecutionError, parseCodexResultEnvelope } from './agent-runner-codex-adapter.mjs';
import { normalizeImplementationApprovers } from './agent-runner-admission.mjs';
import { AGENT_ADAPTERS } from './agent-runner-agents.mjs';
import { resolveDispatchAuthority } from './agent-runner-dispatch-authority.mjs';
import { acquireImplementationSlot } from './agent-runner-implementation-slot.mjs';
import {
  managerAuthorityApprovesAgent,
  resolveCurrentManagerAuthority,
  resolveManagerPreflightExecutionMetadata,
} from './agent-runner-manager-authority.mjs';
import { runCodexQuotaPreflight, sanitizeCodexEnvironment } from './agent-runner-codex-quota-preflight.mjs';
import { selectAgentForIssue } from './agent-runner-routing.mjs';

export const CODEX_CANARY_ISSUE = 186;
export const CODEX_CANARY_REPOSITORY = 'TheTekTeam/agent-runner';
export const CODEX_CANARY_PROFILE = 'codex-canary-v1';
export const CODEX_CANARY_EXPECTED_FILE = 'codex-canary.txt';
export const CODEX_CANARY_EXPECTED_CONTENT = 'AGENT_RUNNER_CODEX_CANARY=PASS\n';
export const CODEX_CANARY_DEFAULT_MODEL = 'gpt-5.6-terra';
export const CODEX_CANARY_DEFAULT_MAX_USED_PERCENT = 90;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_SCHEMA = 'agent-runner-codex-canary/v1';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { execute: false, codexPath: null, maxUsedPercent: CODEX_CANARY_DEFAULT_MAX_USED_PERCENT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') args.execute = true;
    else if (arg === '--codex-path') args.codexPath = argv[++i] || null;
    else if (arg === '--max-used-percent') args.maxUsedPercent = Number(argv[++i]);
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (!args.execute) throw new Error('codex canary requires explicit --execute');
  if (!args.codexPath || !args.codexPath.startsWith('/')) throw new Error('codex canary requires an absolute --codex-path');
  if (!Number.isFinite(args.maxUsedPercent) || args.maxUsedPercent < 0 || args.maxUsedPercent > 100) {
    throw new Error('codex canary max-used-percent is invalid');
  }
  return args;
}

function runGit(args, { cwd = REPO_ROOT, allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function fetchIssueComments() {
  const raw = execFileSync('gh', [
    'api', '--paginate', '--slurp',
    `/repos/${CODEX_CANARY_REPOSITORY}/issues/${CODEX_CANARY_ISSUE}/comments?per_page=100`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2 * 1024 * 1024 });
  const pages = JSON.parse(raw || '[]');
  return pages.flatMap((page) => Array.isArray(page) ? page : [page]);
}

function approvedManager(authority, env = process.env) {
  const { approvers, invalid } = normalizeImplementationApprovers(env.CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS);
  if (invalid.length > 0 || approvers.length === 0) return false;
  const author = String(authority?.comment?.user?.login || '').trim().toLowerCase();
  return approvers.includes(author);
}

function statePath(env = process.env) {
  return env.AGENT_RUNNER_CODEX_CANARY_STATE
    || resolve(String(env.HOME || homedir()), '.local/state/agent-runner/codex-canary-186.json');
}

function writeState(state, env = process.env) {
  const path = statePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readState(env = process.env) {
  const path = statePath(env);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function buildCanarySelection({ resourceState, model = CODEX_CANARY_DEFAULT_MODEL } = {}) {
  const adapter = Object.freeze({ ...AGENT_ADAPTERS['codex-cli'], implemented: true, command: 'codex' });
  const settingsEntry = {
    lifecycle: { enabled: true, disabled: false, paused: false, draining: false },
    qualification: { taskClasses: ['code'], riskClasses: ['low'], models: ['*'], harness: '*' },
    paidUse: { paidUseApproved: false, automaticRoutingApproved: false, hasPositiveCap: false },
  };
  return selectAgentForIssue({
    explicitAgentId: 'codex-cli',
    globalSlotAvailable: true,
    classification: { taskClass: 'code', riskClass: 'low', model, harness: null },
    candidates: [{
      agentId: 'codex-cli',
      adapter,
      settingsEntry,
      readiness: { healthy: true, ready: true },
      resourceState,
    }],
  });
}

export function validateCanaryWorkspace({ cwd, baseCommit } = {}) {
  const expected = join(cwd, CODEX_CANARY_EXPECTED_FILE);
  const head = runGit(['rev-parse', 'HEAD'], { cwd });
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const content = existsSync(expected) ? readFileSync(expected, 'utf8') : null;
  const expectedStatus = `?? ${CODEX_CANARY_EXPECTED_FILE}\n`;
  return Object.freeze({
    ok: head === baseCommit && status === expectedStatus && content === CODEX_CANARY_EXPECTED_CONTENT,
    headUnchanged: head === baseCommit,
    exactExpectedDiff: status === expectedStatus,
    exactExpectedContent: content === CODEX_CANARY_EXPECTED_CONTENT,
  });
}

function safeEvidence({ authority, dispatch, execution, workspace, preflight }) {
  return Object.freeze({
    schemaVersion: STATE_SCHEMA,
    issue: CODEX_CANARY_ISSUE,
    repository: CODEX_CANARY_REPOSITORY,
    authorityKey: authority.authorityKey,
    authorityCommentId: authority.commentIdentity?.id || null,
    baseCommit: dispatch.baseCommit,
    branch: dispatch.branch,
    agentId: 'codex-cli',
    model: execution.model,
    effort: execution.effort,
    authMode: preflight.authMode,
    quota: {
      primaryUsedPercent: preflight.resourceState.primary?.usedPercent ?? null,
      primaryRemainingPercent: preflight.resourceState.primary?.remainingPercent ?? null,
      secondaryUsedPercent: preflight.resourceState.secondary?.usedPercent ?? null,
      secondaryRemainingPercent: preflight.resourceState.secondary?.remainingPercent ?? null,
    },
    selector: 'explicit-assignment-retained',
    adapterAdmission: 'quota-only',
    terminalResult: execution.result,
    headUnchanged: workspace.headUnchanged,
    exactExpectedDiff: workspace.exactExpectedDiff,
    exactExpectedContent: workspace.exactExpectedContent,
    rawPromptPersisted: false,
    providerOutputPersisted: false,
    credentialMaterialPersisted: false,
    creditFieldsUsedForAdmission: false,
    normalCatalogueImplemented: AGENT_ADAPTERS['codex-cli'].implemented,
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);

  if (hostname() !== 'dev-cluster-dell') throw new Error('codex canary may be scheduled only from dev-cluster-dell');
  if (runGit(['branch', '--show-current']) !== 'main') throw new Error('canonical checkout must be on main');
  if (execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }) !== '') {
    throw new Error('canonical checkout must be clean');
  }

  const comments = fetchIssueComments();
  const current = resolveCurrentManagerAuthority(comments);
  if (!current.allowed || !current.authority) throw new Error(current.reason || 'manager-preflight-required');
  const authority = current.authority;
  if (!approvedManager(authority, env)) throw new Error('manager-preflight-author-unapproved');
  if (!managerAuthorityApprovesAgent(authority, 'codex-cli')) throw new Error('manager-preflight-agent-mismatch');

  const metadata = resolveManagerPreflightExecutionMetadata(authority.comment);
  if (metadata.profile !== CODEX_CANARY_PROFILE) throw new Error('codex-canary-profile-mismatch');
  if (metadata.model !== CODEX_CANARY_DEFAULT_MODEL) throw new Error('codex-canary-model-mismatch');
  if (metadata.effort !== 'low') throw new Error('codex-canary-effort-mismatch');

  const dispatch = resolveDispatchAuthority({
    preflight: authority.comment,
    argsRepo: CODEX_CANARY_REPOSITORY,
    config: { githubRepo: CODEX_CANARY_REPOSITORY, localRepoPath: REPO_ROOT },
    runnerCheckout: REPO_ROOT,
  });
  if (!dispatch.ok) throw new Error(dispatch.failureReason);
  if (dispatch.baseCommit !== runGit(['rev-parse', 'HEAD'])) throw new Error('codex-canary-base-head-mismatch');
  if (dispatch.branch === 'main') throw new Error('codex-canary-branch-must-be-isolated');

  const consumed = readState(env);
  if (consumed?.authorityKey === authority.authorityKey) throw new Error('codex-canary-authority-already-consumed');

  const slot = acquireImplementationSlot({ env });
  if (!slot.held) throw new Error(slot.failureReason || 'implementation-slot-unavailable');

  let worktreeParent = null;
  let worktree = null;
  let preserveForensics = false;

  try {
    const preflight = await runCodexQuotaPreflight({
      executablePath: args.codexPath,
      env,
      maxUsedPercent: args.maxUsedPercent,
    });
    if (!preflight.allowed) throw new Error(preflight.reason || 'codex-quota-evidence-unavailable');

    const childEnv = sanitizeCodexEnvironment(env);
    const admission = admitCodexDispatch({
      settings: { agentId: 'codex-cli', routable: true, reason: 'canary-only', entry: { executablePath: args.codexPath } },
      resourceState: preflight.resourceState,
      accessFn: undefined,
      execFileFn: (file, fileArgs) => execFileSync(file, fileArgs, {
        env: childEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    });
    if (!admission.allowed) throw new Error(admission.reason || 'codex-adapter-admission-failed');

    const selection = buildCanarySelection({ resourceState: preflight.resourceState, model: metadata.model });
    if (selection.selectedAgentId !== 'codex-cli' || selection.reason !== 'explicit-assignment-retained') {
      throw new Error('codex-selector-did-not-select-authorised-adapter');
    }

    writeState({
      schemaVersion: STATE_SCHEMA,
      authorityKey: authority.authorityKey,
      authorityCommentId: authority.commentIdentity?.id || null,
      baseCommit: dispatch.baseCommit,
      branch: dispatch.branch,
      status: 'pending',
    }, env);

    if (runGit(['show-ref', '--verify', '--quiet', `refs/heads/${dispatch.branch}`], { allowFailure: true }) !== null) {
      throw new Error('codex-canary-branch-already-exists');
    }

    worktreeParent = mkdtempSync(join(tmpdir(), 'agent-runner-codex-canary-'));
    worktree = join(worktreeParent, 'worktree');
    execFileSync('git', ['worktree', 'add', '-b', dispatch.branch, worktree, dispatch.baseCommit], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const prompt = [
      `Create exactly one new file named ${CODEX_CANARY_EXPECTED_FILE} in the repository root.`,
      `Its complete contents must be exactly: ${CODEX_CANARY_EXPECTED_CONTENT.trim()}`,
      'Do not modify any other file. Do not commit, push, deploy, install packages, change settings, or alter Git configuration.',
      'When the file is correct, stop.',
    ].join(' ');

    const command = buildCodexCommandArgs({
      executablePath: args.codexPath,
      cwd: worktree,
      model: metadata.model,
      sandboxMode: 'workspace-write',
      approvalMode: 'never',
      reasoningEffort: metadata.effort,
      prompt,
    });

    const child = spawnSync(command[0], command.slice(1), {
      cwd: worktree,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    let normalized;
    if (child.error || child.signal || child.status !== 0) {
      normalized = classifyCodexExecutionError({
        timedOut: child.error?.code === 'ETIMEDOUT',
        cancelled: Boolean(child.signal),
        signal: child.signal,
        code: child.status,
      });
    } else {
      normalized = parseCodexResultEnvelope(child.stdout);
    }

    const workspace = validateCanaryWorkspace({ cwd: worktree, baseCommit: dispatch.baseCommit });
    const parserMutationAgrees = normalized.ok && normalized.mutatedRepository === true;
    if (!parserMutationAgrees || !workspace.ok) {
      preserveForensics = true;
      writeState({
        schemaVersion: STATE_SCHEMA,
        authorityKey: authority.authorityKey,
        authorityCommentId: authority.commentIdentity?.id || null,
        baseCommit: dispatch.baseCommit,
        branch: dispatch.branch,
        status: 'failed',
        reason: !normalized.ok
          ? (normalized.reason || 'codex-canary-parser-failed')
          : !parserMutationAgrees
            ? 'codex-parser-mutation-disagreement'
            : 'codex-canary-workspace-validation-failed',
      }, env);
      throw new Error(!normalized.ok
        ? (normalized.reason || 'codex-canary-parser-failed')
        : !parserMutationAgrees
          ? 'codex-parser-mutation-disagreement'
          : 'codex-canary-workspace-validation-failed');
    }

    const evidence = safeEvidence({
      authority,
      dispatch,
      preflight,
      workspace,
      execution: {
        model: metadata.model,
        effort: metadata.effort,
        result: normalized.reason || 'completed',
      },
    });

    writeState({ ...evidence, status: 'completed' }, env);

    rmSync(join(worktree, CODEX_CANARY_EXPECTED_FILE));
    if (execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }) !== '') {
      preserveForensics = true;
      throw new Error('codex-canary-cleanup-refused-dirty-worktree');
    }

    execFileSync('git', ['worktree', 'remove', worktree], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
    worktree = null;
    execFileSync('git', ['branch', '-d', dispatch.branch], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
    rmSync(worktreeParent, { recursive: true, force: true });
    worktreeParent = null;

    console.log(JSON.stringify(evidence, null, 2));
    console.log('AR186_CODEX_CANARY=PASS');
    return 0;
  } finally {
    slot.release();
    if (!preserveForensics && worktreeParent && !worktree) rmSync(worktreeParent, { recursive: true, force: true });
  }
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === new URL(process.argv[1], `file://${process.cwd()}/`).href
  : false;

if (invokedAsScript) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(JSON.stringify({
      canary: 'failed',
      reason: String(error?.message || error).replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 120),
      rawProviderOutputPersisted: false,
    }));
    process.exitCode = 1;
  }
}
