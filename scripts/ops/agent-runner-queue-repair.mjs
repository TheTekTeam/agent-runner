#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import {
  applyFalseBlockRestorationPlan,
  buildFalseBlockRestorationPlan,
} from './agent-runner-false-block-restoration.mjs';
import { defaultRunnerStateDbPath, openRunnerStateStore } from './claude-runner-state.mjs';

export function parseRepairArgs(argv = process.argv.slice(2), env = process.env) {
  const config = loadAgentRunnerConfig({ argv, env });
  const args = {
    incident: '2026-07-20-queue-drain',
    repo: env.GITHUB_REPOSITORY || config.githubRepo,
    stateDbPath: env.CLAUDE_RUNNER_STATE_DB || config.stateDbPath || defaultRunnerStateDbPath(config.outputDir || '.var/claude-runner'),
    startAt: '2026-07-20T00:00:00.000Z',
    endAt: '2026-07-21T00:00:00.000Z',
    execute: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--incident') args.incident = next();
    else if (arg === '--repo') args.repo = next();
    else if (arg === '--state-db') args.stateDbPath = next();
    else if (arg === '--start-at') args.startAt = next();
    else if (arg === '--end-at') args.endAt = next();
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run') args.execute = false;
    else if (arg === '--config') index += 1;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.incident !== '2026-07-20-queue-drain') throw new Error(`unsupported incident: ${args.incident}`);
  if (!args.repo) throw new Error('repository is required');
  return args;
}

function boundedProposal(proposal) {
  return {
    issueNumber: proposal.issueNumber,
    incidentRecordId: proposal.incidentRecordId,
    restorable: proposal.restorable,
    reason: proposal.reason,
    fromStatus: proposal.fromStatus || null,
    toStatus: proposal.toStatus || null,
    linkedOpenPullRequestNumbers: proposal.linkedOpenPullRequestNumbers || [],
    safeNextAction: proposal.safeNextAction,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const args = parseRepairArgs(argv, env);
  const openStore = dependencies.openStore || openRunnerStateStore;
  const store = openStore(args.stateDbPath);
  try {
    const plan = buildFalseBlockRestorationPlan(store, {
      repo: args.repo,
      startAt: args.startAt,
      endAt: args.endAt,
      ghRunner: dependencies.ghRunner,
    });
    const base = {
      schemaVersion: 'agent-runner-queue-repair/v1',
      incident: args.incident,
      repository: args.repo,
      mode: args.execute ? 'apply' : 'dry-run',
      classifiedRows: plan.incident.total,
      ambiguousRows: plan.incident.ambiguous,
      proposedRestorations: plan.restorable,
      withheld: plan.withheld,
      proposals: plan.proposals.map(boundedProposal),
    };

    if (!args.execute) {
      console.log(JSON.stringify({
        ...base,
        applied: 0,
        issueMutation: false,
        stateMutation: false,
        safeNextAction: plan.incident.ambiguous > 0
          ? 'Resolve ambiguous incident rows before applying restoration.'
          : 'Review this proposal, then rerun with --execute on the canonical Dell state database.',
      }, null, 2));
      return plan.incident.ambiguous > 0 ? 2 : 0;
    }

    if (plan.incident.ambiguous > 0) {
      console.log(JSON.stringify({
        ...base,
        applied: 0,
        issueMutation: false,
        stateMutation: false,
        blocked: true,
        reason: 'ambiguous-incident-evidence',
        safeNextAction: 'Resolve every ambiguous row and rerun the dry-run proposal.',
      }, null, 2));
      return 2;
    }

    const applied = applyFalseBlockRestorationPlan(store, plan, {
      repo: args.repo,
      ghRunner: dependencies.ghRunner,
      now: dependencies.now,
    });
    console.log(JSON.stringify({
      ...base,
      applied: applied.applied,
      failedOrWithheld: applied.withheld,
      issueMutation: applied.applied > 0,
      stateMutation: applied.applied > 0,
      results: applied.results.map(boundedProposal),
      safeNextAction: applied.applied === plan.restorable
        ? 'Verify restored issues remain truthful and proceed to the bounded standalone canary.'
        : 'Inspect every failed or withheld restoration before any canary run.',
    }, null, 2));
    return applied.applied === plan.restorable ? 0 : 1;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
