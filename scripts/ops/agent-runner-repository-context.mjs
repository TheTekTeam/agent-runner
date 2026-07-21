import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The runner's own canonical identity (docs/ops/AGENT-RUNNER-STANDALONE.md:
// "The canonical runner repository is TheTekTeam/agent-runner"). This is a
// fixed fact about the tool, not something a configured project can rename.
export const RUNNER_OWN_REPOSITORY = 'TheTekTeam/agent-runner';
export const RUNNER_OWN_REPOSITORY_INSTRUCTIONS = Object.freeze(['AGENTS.md']);

// The historical ModelSpend instruction set, unchanged from the prompt text
// this replaces, kept as the default so ordinary same-repository project
// work is byte-for-byte unaffected.
export const DEFAULT_PROJECT_REPOSITORY_INSTRUCTIONS = Object.freeze([
  'CLAUDE.md',
  'docs/claude/README.md',
  'docs/ai/AGENT-ORCHESTRATION-WORKFLOW.md',
  'docs/claude/VALIDATION-GATES.md',
]);

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function normalized(value) {
  return String(value ?? '').trim();
}

/**
 * Resolve the runner's own checkout root from a script's import.meta.url.
 * Callers pass the URL of a file directly under scripts/ops/, mirroring
 * agent-runner-supervised-canary.mjs's own ROOT computation.
 */
export function runnerOwnCheckoutRoot(scriptUrl) {
  return resolve(dirname(fileURLToPath(scriptUrl)), '..', '..');
}

/**
 * Build the explicit repository-context boundary consumed by prompt
 * generation, worktree preparation and draft-PR publication.
 *
 * Four identities are kept distinct rather than collapsed into one "repo":
 * - issueRepository: where the triggering issue/comments live.
 * - projectRepository: the configured project's repository identity.
 * - implementationRepository: where the code change actually happens.
 * - implementationCheckout: the local git checkout backing that repository.
 *
 * implementationRepository defaults to projectRepository (the normal,
 * same-repository case). It only diverges when a caller explicitly names a
 * *known* repository via requestedImplementationRepository -- currently
 * either the configured project or the runner's own repository. Naming
 * anything else fails closed instead of silently falling back to the
 * project identity or trusting an unvalidated filesystem path: the #686
 * canary's failure mode was exactly this collapse, where every downstream
 * consumer (prompt text, worktree root, draft-PR target) quietly resolved
 * to the configured project even though the requested change belonged to
 * the runner's own repository.
 *
 * implementationCheckout is always sourced from validated machine-local
 * configuration (projectCheckout from the loaded project config, or
 * runnerCheckout derived from this script's own location) -- never from
 * issue/comment text, which must not be able to point runner git commands
 * at an arbitrary filesystem path.
 */
export function resolveRepositoryContext({
  issueRepository,
  projectRepository,
  projectCheckout,
  projectInstructionPaths = DEFAULT_PROJECT_REPOSITORY_INSTRUCTIONS,
  runnerRepository = RUNNER_OWN_REPOSITORY,
  runnerCheckout,
  runnerInstructionPaths = RUNNER_OWN_REPOSITORY_INSTRUCTIONS,
  requestedImplementationRepository,
} = {}) {
  const issueRepo = normalized(issueRepository);
  const projectRepo = normalized(projectRepository);
  const projectPath = normalized(projectCheckout);

  if (!REPO_PATTERN.test(issueRepo)) {
    return { allowed: false, failureReason: 'repository-context-issue-repository-invalid', context: null };
  }
  if (!REPO_PATTERN.test(projectRepo)) {
    return { allowed: false, failureReason: 'repository-context-project-repository-invalid', context: null };
  }
  if (!projectPath) {
    return { allowed: false, failureReason: 'repository-context-project-checkout-missing', context: null };
  }

  const registry = new Map();
  registry.set(projectRepo, {
    checkout: projectPath,
    instructionPaths: [...projectInstructionPaths],
  });

  const runnerRepo = normalized(runnerRepository);
  const runnerPath = normalized(runnerCheckout);
  if (runnerRepo && runnerPath && REPO_PATTERN.test(runnerRepo) && !registry.has(runnerRepo)) {
    registry.set(runnerRepo, {
      checkout: runnerPath,
      instructionPaths: [...runnerInstructionPaths],
    });
  }

  const requested = normalized(requestedImplementationRepository);
  if (requested && !REPO_PATTERN.test(requested)) {
    return { allowed: false, failureReason: 'implementation-repository-format-invalid', context: null };
  }

  const implementationRepository = requested || projectRepo;
  const entry = registry.get(implementationRepository);
  if (!entry) {
    return { allowed: false, failureReason: 'implementation-repository-not-recognized', context: null };
  }

  return {
    allowed: true,
    failureReason: null,
    context: {
      issueRepository: issueRepo,
      projectRepository: projectRepo,
      implementationRepository,
      implementationCheckout: entry.checkout,
      implementationInstructionPaths: entry.instructionPaths,
    },
  };
}
