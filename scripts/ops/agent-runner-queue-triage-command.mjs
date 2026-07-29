import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  generateOpenAIOversightPrompt,
  planQueueTriageRun,
  renderQueueTriageMarkdown,
} from './agent-runner-queue-triage.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/ops/agent-runner-queue-triage-command.mjs --input <normalized-evidence.json> [--format json|markdown]',
    '  node scripts/ops/agent-runner-queue-triage-command.mjs --format openai',
    '',
    'This foundation is dry-run only. --execute is intentionally unsupported.',
  ].join('\n');
}

export function parseQueueTriageArgs(argv = []) {
  const parsed = { input: null, format: 'json', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--execute') throw new Error('--execute is not available in the dry-run foundation');
    else if (arg === '--input') {
      parsed.input = argv[++index];
      if (!parsed.input || parsed.input.startsWith('--')) throw new Error('--input requires a path');
    } else if (arg.startsWith('--input=')) parsed.input = arg.slice('--input='.length);
    else if (arg === '--format') {
      parsed.format = argv[++index];
      if (!parsed.format || parsed.format.startsWith('--')) throw new Error('--format requires a value');
    } else if (arg.startsWith('--format=')) parsed.format = arg.slice('--format='.length);
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (!['json', 'markdown', 'openai'].includes(parsed.format)) throw new Error('--format must be json, markdown or openai');
  if (!parsed.help && parsed.format !== 'openai' && !parsed.input) throw new Error('--input is required unless --format openai is used');
  return Object.freeze(parsed);
}

export function runQueueTriageCommand({ argv = process.argv.slice(2), readFile = readFileSync } = {}) {
  const args = parseQueueTriageArgs(argv);
  if (args.help) return `${usage()}\n`;
  if (args.format === 'openai') return `${generateOpenAIOversightPrompt()}\n`;
  const input = JSON.parse(readFile(resolve(args.input), 'utf8'));
  const report = planQueueTriageRun(input);
  return args.format === 'markdown'
    ? renderQueueTriageMarkdown(report)
    : `${JSON.stringify(report)}\n`;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.stdout.write(runQueueTriageCommand());
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'queue-triage-command-failed', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
