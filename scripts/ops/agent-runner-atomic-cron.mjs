#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH,
  candidatePausePayload,
} from './agent-runner-candidate-admission.mjs';
import {
  createAtomicAdmissionStore,
  revalidationFailureEvidence,
  runAtomicCandidateRevalidation,
} from './agent-runner-atomic-candidate-store.mjs';
import { acquireRecoverableCronLock } from './agent-runner-cron-lock.mjs';
import { safeDeriveFailureProjection } from './agent-runner-failure-attention-projection.mjs';
import {
  createLivenessFilteredStore,
  inspectDueRecoveryLiveness,
} from './agent-runner-live-liveness.mjs';
import { withRecoveryIdentityGuard } from './agent-runner-recovery-identity-guard.mjs';
import { parseStructuredOutput, serviceExitCode } from './agent-runner-service-semantics.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';
import { main as schedulerMain, parseArgs as schedulerParseArgs, upsertGitHubAttentionComment } from './claude-runner-cron.mjs';

const PRE_CLAIM_PROJECTABLE_SCOPES = Object.freeze(['machine_profile', 'issue_not_runnable']);

/**
 * #231: the *only* production path a candidate cost-admission refusal or
 * #229 tool-capability mismatch pause currently reaches is this function's
 * own stdout JSON (`candidatePausePayload`) -- a shell-only artifact. This
 * publishes the same bounded #230 projection through the existing canonical
 * `upsertGitHubAttentionComment()` GitHub channel, content-equality
 * deduplicated exactly like every other attention comment, so a normal
 * manager session can read the exact machine-profile reason, the zero-
 * side-effect evidence and the safe next action from the issue itself.
 * Never throws: a broken GitHub write here must never turn a handled
 * candidate-pause exit (0, durably audited above) into a failure.
 *
 * Exported so `agent-runner-candidate-pause-publish.mjs` -- the outer
 * `bin/run-project.sh` wrapper's own pre-claim candidate-admission call,
 * which never enters this module's atomic revalidation transaction -- can
 * publish through the exact same rendering and GitHub mutation logic
 * instead of a second, duplicated implementation (#231).
 */
export function publishCandidatePauseAttention({ repo, project, admission, current, ghRunner }) {
  if (!repo || !PRE_CLAIM_PROJECTABLE_SCOPES.includes(admission?.scope)) return;
  const issueNumber = current?.issueNumber;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return;
  const reasonDomain = admission.scope === 'issue_not_runnable'
    ? 'candidate_admission'
    : (admission.reason === IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH ? 'capability_admission' : 'cost_admission');
  const safeNextAction = typeof admission.safeNextAction === 'string' && admission.safeNextAction.trim()
    ? admission.safeNextAction.trim()
    : 'Provide an explicit manager decision before any further dispatch. Do not retry automatically.';
  const projection = safeDeriveFailureProjection({
    repository: repo, project: project ?? null, issueNumber,
    // Pre-attempt: no attempt has been created for this refusal (see
    // `attemptCreated: false` below), so there is no real attempt identity
    // to project -- `null` is the correct, honest value here, not a guess.
    attemptId: null,
    executionPhase: reasonDomain,
    candidateAdmissionCompleted: admission.scope === 'machine_profile',
    attemptCreated: false, managerPacketConsumed: null, issueMutation: false,
    workspaceCreated: false, childLaunched: false, providerInvocationObserved: 'no',
    failureScope: admission.scope, reasonDomain, reason: admission.reason,
    missingCapabilities: reasonDomain === 'capability_admission' ? (admission.missingCapabilities || []) : [],
    checkpointPresent: false, worktreePresent: false, branchPresent: false, commitPresent: false, prPresent: false,
    dirty: false, hasChanges: false,
    recoveryStatus: 'forbidden', recoveryAction: 'attention_required', recoveryEligible: false,
    circuitState: reasonDomain === 'cost_admission' && admission.effectiveFingerprint ? 'tripped' : null,
    circuitDomain: reasonDomain === 'cost_admission' && admission.effectiveFingerprint ? 'cost_admission' : null,
    safeNextAction,
    deeperDiagnosticsRequired: false,
  });
  const failure = {
    failureScope: admission.scope,
    reason: admission.reason,
    recoveryStatus: 'forbidden',
    nextAction: safeNextAction,
    finishedAt: new Date().toISOString(),
    policyRevision: 'runner-recovery-v1',
    projection,
  };
  try {
    upsertGitHubAttentionComment({ repo }, { number: issueNumber }, failure, ghRunner);
  } catch { /* a GitHub write failure must never change this handled pause's exit semantics */ }
}

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
    publishCandidatePauseAttention({
      repo: parsedArgs.repo, project: parsedArgs.project?.id,
      admission: pauseState.result.admission, current: pauseState.result.current,
      ghRunner: dependencies.ghRunner,
    });
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
