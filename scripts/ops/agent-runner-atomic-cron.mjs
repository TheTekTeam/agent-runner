#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { candidatePausePayload } from './agent-runner-candidate-admission.mjs';
import {
  createAtomicAdmissionStore,
  revalidationFailureEvidence,
  runAtomicCandidateRevalidation,
} from './agent-runner-atomic-candidate-store.mjs';
import { acquireRecoverableCronLock } from './agent-runner-cron-lock.mjs';
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
      // The imported scheduler cannot distinguish a broken atomic
      // revalidation subprocess from a genuine state-store failure, so its
      // own `runner_state_unavailable` line here is never the operator's
      // authoritative record when `pauseState.revalidationFailure` is set —
      // the correction below replaces it.
      if (!pauseState.result && !pauseState.revalidationFailure) baseLogger.error(...values);
    },
  };

  let exitCode;
  try {
    exitCode = await schedulerMain(argv, env, {
      ...dependencies,
      acquireLock: dependencies.acquireLock || acquireRecoverableCronLock,
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

  // A broken atomic revalidation subprocess (missing module, crashed spawn,
  // unparsable output) is not a candidate denial and must stay fail-closed —
  // unlike the branch above, this never returns 0. It also is not a state
  // store failure: the imported scheduler's own evidence (`finalPayload`)
  // mislabels it `runner_state_unavailable` because its state recorder
  // catches every store-method throw uniformly. Correct the reason and
  // safe-next-action here, where the real cause is known, while preserving
  // `systemicPause`, `stage`, and the fail-closed exit code untouched.
  if (pauseState.revalidationFailure) {
    const evidence = revalidationFailureEvidence(pauseState.revalidationFailure);
    const corrected = {
      ...(finalPayload || { systemicPause: true }),
      reason: evidence.reason,
      safeNextAction: evidence.safeNextAction,
      candidateRevalidationFailure: String(pauseState.revalidationFailure?.message || pauseState.revalidationFailure),
    };
    baseLogger.error(JSON.stringify(corrected, null, 2));
    return serviceExitCode(exitCode || 1, corrected);
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
