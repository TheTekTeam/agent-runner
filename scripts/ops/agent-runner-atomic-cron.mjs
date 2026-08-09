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
import { withRecoveryIdentityGuard } from './agent-runner-recovery-identity-guard.mjs';
import { parseStructuredOutput, serviceExitCode } from './agent-runner-service-semantics.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';
import { main as schedulerMain, parseArgs as schedulerParseArgs } from './claude-runner-cron.mjs';

export * from './claude-runner-cron.mjs';

export function createStableOutputCapture({ logger, originalConsoleLog, originalConsoleError, onValues }) {
  const baseLogger = logger || {
    log: originalConsoleLog.bind(console),
    error: originalConsoleError.bind(console),
  };
  const record = (values) => onValues?.(values);
  return {
    baseLogger,
    directLog: (...values) => {
      record(values);
      originalConsoleLog(...values);
    },
    directError: (...values) => {
      record(values);
      originalConsoleError(...values);
    },
    loggerLog: (...values) => {
      record(values);
      baseLogger.log(...values);
    },
    loggerError: (...values) => {
      record(values);
      baseLogger.error(...values);
    },
  };
}

/**
 * The exact runner-state composition this production entrypoint hands to the
 * imported scheduler. Exported so regressions exercise the real composition
 * rather than a hand-rebuilt copy of it (#158).
 *
 * The #148 recovery-identity guard is attached to the concrete store instance
 * that *owns* the SQLite connection, never to a delegating layer above it.
 * `withRecoveryIdentityGuard()` installs its wrapper by assigning
 * `store.recordRecoveryAttempt`, and the liveness/admission layers here are
 * `Proxy` objects with no `set` trap, so that assignment passes straight
 * through and lands as an own property on the innermost store -- while the
 * `original` the guard captured is the outer proxy's own method, which
 * re-resolves `recordRecoveryAttempt` by property lookup on its target and so
 * lands back inside the guard. Guarding the *composed* store (which is what
 * `createStateRecorder()` did to whatever `openStore` returned) therefore
 * opened `BEGIN IMMEDIATE` twice on the one connection -- SQLite's "cannot
 * start a transaction within a transaction" -- failing every implementation
 * dispatch at `attempt-start` with `runner_state_unavailable`.
 *
 * Guarding here keeps exactly one transaction owner, and keeps the admission
 * decision (which spawns a `gh`-calling revalidation subprocess) entirely
 * outside that write transaction. `createStateRecorder()`'s own
 * `withRecoveryIdentityGuard()` call reads the guard marker through these
 * proxies and returns the store unchanged.
 */
export function openAtomicRunnerStateStore(dbPath, {
  openStore = openRunnerStateStore,
  livenessDecisions = [],
  argv = [],
  env = process.env,
  pauseState = { result: null },
  revalidate = runAtomicCandidateRevalidation,
} = {}) {
  return createAtomicAdmissionStore(
    createLivenessFilteredStore(withRecoveryIdentityGuard(openStore(dbPath)), livenessDecisions),
    { argv, env, pauseState, revalidate },
  );
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const pauseState = { result: null };
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  let finalPayload = null;
  const capture = createStableOutputCapture({
    logger: dependencies.logger,
    originalConsoleLog,
    originalConsoleError,
    onValues: (values) => {
      const parsed = parseStructuredOutput(values);
      if (parsed) finalPayload = parsed;
    },
  });
  const baseLogger = capture.baseLogger;
  const openStore = dependencies.openStore || openRunnerStateStore;
  const revalidate = dependencies.revalidateCandidate || runAtomicCandidateRevalidation;
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

  const atomicOpenStore = (dbPath) => openAtomicRunnerStateStore(dbPath, {
    openStore,
    livenessDecisions,
    argv,
    env,
    pauseState,
    revalidate,
  });

  console.log = capture.directLog;
  console.error = capture.directError;

  const logger = {
    log: capture.loggerLog,
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
