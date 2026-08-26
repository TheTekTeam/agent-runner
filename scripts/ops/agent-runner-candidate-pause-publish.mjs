#!/usr/bin/env node

/**
 * #231: `bin/run-project.sh` runs its own pre-claim
 * `agent-runner-candidate-admission.mjs` check before the pinned atomic
 * runner (`agent-runner-pinned-atomic-cron.mjs` ->
 * `agent-runner-atomic-cron.mjs`) is ever exec'd. A handled refusal there
 * never enters that module's atomic revalidation transaction, so it never
 * reached `publishCandidatePauseAttention()` -- the only production path
 * that projected a candidate pause onto the canonical GitHub attention
 * channel was the *reentrant* atomic-store revalidation, not this outer,
 * earlier check. This bridge closes that gap by reusing the exact same
 * publisher, never a second rendering/GitHub-mutation implementation.
 *
 * Deliberately narrow: reads the candidate-admission CLI's own JSON stdout
 * (passed through unchanged by the wrapper) and the wrapper's own argv/env,
 * and never throws -- a publication failure here must never change the
 * wrapper's already-handled, already-recorded exit-0 pause outcome.
 */

import { pathToFileURL } from 'node:url';

import { publishCandidatePauseAttention } from './agent-runner-atomic-cron.mjs';
import { parseArgs as schedulerParseArgs } from './claude-runner-cron.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const raw = env.AGENT_RUNNER_CANDIDATE_ADMISSION_JSON;
  if (!raw) return 0;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const admission = parsed?.admission;
  if (!admission || typeof admission !== 'object') return 0;
  try {
    const parsedArgs = schedulerParseArgs(argv, env);
    publishCandidatePauseAttention({
      repo: parsedArgs.repo,
      project: parsedArgs.project?.id ?? null,
      admission,
      current: parsed?.current ?? {},
    });
  } catch {
    // A broken pre-claim publish must never affect the wrapper's already
    // handled (exit 0), already durably-recorded pause outcome.
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 0;
  });
}
