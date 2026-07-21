#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { candidatePausePayload } from './agent-runner-candidate-admission.mjs';
import {
  createAtomicAdmissionStore,
  runAtomicCandidateRevalidation,
} from './agent-runner-atomic-candidate-store.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';
import { main as schedulerMain } from './claude-runner-cron.mjs';

export * from './claude-runner-cron.mjs';

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const pauseState = { result: null };
  const baseLogger = dependencies.logger || console;
  const openStore = dependencies.openStore || openRunnerStateStore;
  const revalidate = dependencies.revalidateCandidate || runAtomicCandidateRevalidation;

  const atomicOpenStore = (dbPath) => createAtomicAdmissionStore(openStore(dbPath), {
    argv,
    env,
    pauseState,
    revalidate,
  });

  const logger = {
    log: (...values) => baseLogger.log(...values),
    error: (...values) => {
      if (!pauseState.result) baseLogger.error(...values);
    },
  };

  const exitCode = await schedulerMain(argv, env, {
    ...dependencies,
    openStore: atomicOpenStore,
    logger,
  });

  if (!pauseState.result) return exitCode;

  const payload = {
    ...candidatePausePayload(pauseState.result.admission, pauseState.result.current),
    admissionBoundary: 'recordRecoveryAttempt',
    durableAudit: true,
  };
  baseLogger.log(JSON.stringify(payload, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
