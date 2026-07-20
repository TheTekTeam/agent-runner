#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const DEFAULT_REPO = process.env.MODELSPEND_REPO || 'TheTekTeam/modelspend';

function usage(exitCode = 0) {
  console.log(`GitHub manager helper\n\nUsage:\n  node scripts/ops/github-manager.mjs close-issue --issue <n> [--comment <text>] [--reason completed|not_planned] [--execute]\n  node scripts/ops/github-manager.mjs close-pr --pr <n> [--comment <text>] [--execute]\n  node scripts/ops/github-manager.mjs sync-merged-pr --pr <n> [--execute]\n  node scripts/ops/github-manager.mjs comment --issue <n> --comment <text> [--execute]\n  node scripts/ops/github-manager.mjs comment-pr --pr <n> --comment <text> [--execute]\n\nOptions:\n  --repo <owner/name>  Repository, defaults to ${DEFAULT_REPO}\n  --execute            Required for writes. Without it, prints the intended action only.\n\nSafety:\n  - Dry-run by default.\n  - Never merges PRs or approves reviews.\n  - Intended for human/operator issue closure and small sync comments from the Dell box.\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, repo: DEFAULT_REPO, execute: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--execute') args.execute = true;
    else if (arg === '--repo') args.repo = rest[++i];
    else if (arg === '--issue') args.issue = Number(rest[++i]);
    else if (arg === '--pr') args.pr = Number(rest[++i]);
    else if (arg === '--comment') args.comment = rest[++i];
    else if (arg === '--reason') args.reason = rest[++i];
    else if (arg === '--help' || arg === '-h') usage(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function runGh(args, { input } = {}) {
  const result = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    stdio: input == null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function requireNumber(name, value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Missing or invalid --${name}`);
}

function requireComment(args) {
  if (!args.comment || !args.comment.trim()) throw new Error('Missing --comment');
}

function printPlan(args, lines) {
  console.log(JSON.stringify({ dryRun: !args.execute, repo: args.repo, command: args.command, plan: lines }, null, 2));
}

function closeIssue(args) {
  requireNumber('issue', args.issue);
  const reason = args.reason || 'completed';
  if (!['completed', 'not_planned'].includes(reason)) throw new Error('--reason must be completed or not_planned');
  const plan = [`Close issue #${args.issue} as ${reason}`];
  if (args.comment) plan.push(`Add close comment: ${args.comment}`);
  printPlan(args, plan);
  if (!args.execute) return;
  const ghArgs = ['issue', 'close', String(args.issue), '--repo', args.repo, '--reason', reason];
  if (args.comment) ghArgs.push('--comment', args.comment);
  console.log(runGh(ghArgs));
}

function closePr(args) {
  requireNumber('pr', args.pr);
  const plan = [`Close PR #${args.pr}`];
  if (args.comment) plan.push(`Add close comment: ${args.comment}`);
  printPlan(args, plan);
  if (!args.execute) return;
  const ghArgs = ['pr', 'close', String(args.pr), '--repo', args.repo];
  if (args.comment) ghArgs.push('--comment', args.comment);
  console.log(runGh(ghArgs));
}

function commentIssue(args, numberField = 'issue') {
  const number = args[numberField];
  requireNumber(numberField, number);
  requireComment(args);
  printPlan(args, [`Comment on ${numberField} #${number}: ${args.comment}`]);
  if (!args.execute) return;
  const target = numberField === 'pr' ? ['pr', 'comment'] : ['issue', 'comment'];
  console.log(runGh([...target, String(number), '--repo', args.repo, '--body', args.comment]));
}

function parseLinkedIssues(text) {
  const matches = [];
  const re = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  let match;
  while ((match = re.exec(text || ''))) matches.push(Number(match[1]));
  return [...new Set(matches)];
}

function syncMergedPr(args) {
  requireNumber('pr', args.pr);
  const raw = runGh(['pr', 'view', String(args.pr), '--repo', args.repo, '--json', 'number,title,body,merged,url,headRefName']);
  const pr = JSON.parse(raw);
  const linkedIssues = parseLinkedIssues(`${pr.title}\n${pr.body || ''}`);
  const plan = [`Inspect PR #${args.pr} merged state`];
  if (!pr.merged) plan.push('PR is not merged; no issue closure will be attempted.');
  else if (linkedIssues.length === 0) plan.push('PR is merged but no Closes/Fixes/Resolves issue reference was found.');
  else linkedIssues.forEach((issue) => plan.push(`Close linked issue #${issue} as completed with merged PR evidence.`));
  printPlan(args, plan);
  if (!args.execute || !pr.merged || linkedIssues.length === 0) return;
  for (const issue of linkedIssues) {
    runGh([
      'issue',
      'close',
      String(issue),
      '--repo',
      args.repo,
      '--reason',
      'completed',
      '--comment',
      `Closed from Dell GitHub manager after merged PR #${pr.number}: ${pr.url}`,
    ]);
    console.log(`closed issue #${issue}`);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command) usage(1);
  if (!args.repo) throw new Error('Missing --repo');
  if (args.command === 'close-issue') closeIssue(args);
  else if (args.command === 'close-pr') closePr(args);
  else if (args.command === 'comment') commentIssue(args, 'issue');
  else if (args.command === 'comment-pr') commentIssue(args, 'pr');
  else if (args.command === 'sync-merged-pr') syncMergedPr(args);
  else throw new Error(`Unknown command: ${args.command}`);
} catch (error) {
  console.error(`[github-manager] ERROR: ${error.message}`);
  process.exit(1);
}
