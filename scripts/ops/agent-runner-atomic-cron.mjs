#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { candidatePausePayload } from './agent-runner-candidate-admission.mjs';
import {
  createAtomicAdmissionStore,
  runAtomicCandidateRevalidation,
} from './agent-runner-atomic-candidate-store.mjs';
import {
  createLivenessFilteredStore,
  inspectDueRecoveryLiveness,
} from './agent-runner-live-liveness.mjs';
import { parseStructuredOutput, serviceExitCode } from './agent-runner-service-semantics.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';
import { main as schedulerMain, parseArgs as schedulerParseArgs } from './claude-runner-cron.mjs';

export * from './claude-runner-cron.mjs';

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const pauseState = { result: null };
  const baseLogger = dependencies.logger || console;
  const openStore = dependencies.openStore || openRunnerStateStore;
  const revalidate = dependencies.revalidateCandidate || runAtomicCandidateRevalidation;
  let finalPayload = null;
  let livenessDecisions = [];

  const parsedArgs = (dependencies.parseArgs || schedulerParseArgs)(argv, env);
  if (parsedArgs.execute) {
    const inspectionStore = openStore(parsedArgs.stateDbPath);
    try {
      livenessDecisions = await (dependencies.inspectDueRecoveryLiveness || inspectDueRecoveryLiveness)({
        store: inspectionStore,
        repo: parsedArgs.repo,
        at: (dependencies.now || (() => new Date().toISOString()))(),
        ghRunner: dependencies.ghRunner,
        processProbe: dependencies.processProbe,
        stallPassLimit: parsedArgs.stalledPassLimit,
        now: dependencies.now,
      });
    } finally {
      inspectionStore.close();
    }
  }

  const atomicOpenStore = (dbPath) => createAtomicAdmissionStore(
    createLivenessFilteredStore(openStore(dbPath), livenessDecisions),
    {
      argv,
      env,
      pauseState,
      revalidate,
    },
  );

  const capture = (method) => (...values) => {
    const parsed = parseStructuredOutput(values);
    if (parsed) finalPayload = parsed;
    baseLogger[method](...values);
  };
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = capture('log');
  console.error = capture('error');

  const logger = {
    log: capture('log'),
    error: (...values) => {
      const parsed = parseStructuredOutput(values);
      if (parsed) finalPayload = parsed;
      if (!pauseState.result) baseLogger.error(...values);
    },
  };

  let exitCode;
  try {
    exitCode = await schedulerMain(argv, env, {
      ...dependencies,
      openStore: atomicOpenStore,
      logger,
    });
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  if (pauseState.result) {
    const payload = {
      ...candidatePausePayload(pauseState.result.admission, pauseState.result.current),
      admissionBoundary: 'recordRecoveryAttempt',
      durableAudit: true,
    };
    baseLogger.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  return serviceExitCode(exitCode, finalPayload);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
