# Agent Runner GitHub checks provider

Issue: `TheTekTeam/agent-runner#107`

This provider supplies complete, bounded GitHub CI observations to the durable event-settlement state machine in #103. It is generic across every repository enabled in the Agent Runner project registry and contains no ModelSpend-specific workflow, job, check, branch, or package assumptions.

## Read surfaces

For each SHA currently required by a settlement batch, the provider reads:

- check runs;
- check suites;
- workflow runs filtered to the SHA;
- every workflow job for each returned workflow run;
- individual commit-status contexts.

Every surface is paginated. Workflow-run-to-job expansion is also bounded. Reaching a configured page or workflow-run limit marks the snapshot incomplete; it never silently truncates evidence.

## Settlement contract

The provider writes one normalized snapshot for each required SHA:

```js
{
  sha,
  observedAt,
  queryComplete,
  checks: [
    { provider, externalId, name, status, conclusion }
  ]
}
```

`queryComplete` is `false` when any required surface:

- fails;
- times out;
- is rate limited;
- returns malformed JSON or an unexpected response shape;
- cannot be fully paginated within the configured bounds;
- contains a workflow run whose jobs cannot be completely read.

An incomplete snapshot blocks settlement. It is never interpreted as a clean no-check result.

A complete response with zero checks is valid evidence that no check/run/status records were present for the SHA at that observation time. The final quiet-period refresh can still discover a workflow that starts later and reset settlement.

## Status handling

The provider preserves GitHub status and conclusion values after bounded normalization. The #103 settlement module remains authoritative for terminal versus non-terminal classification.

Workflow runs and jobs are recorded separately. This gives the debugger and audit layer enough evidence to identify a waiting or failing job without depending only on the aggregate workflow-run state.

## Dell GitHub client

`GhCliGitHubReadClient` invokes only:

```text
gh api --method GET /repos/...
```

The endpoint must begin with `/repos/`. The client:

- applies a bounded timeout and output limit;
- passes only an explicit environment allowlist needed by `gh` and TLS/proxy configuration;
- forces non-interactive output;
- parses JSON only;
- returns bounded error codes;
- never returns or persists raw stderr, tokens, request headers, or API payloads.

The provider supports the Dell's existing authenticated `gh` session or a protected `GH_TOKEN`/`GITHUB_TOKEN` supplied through machine-local policy. Credentials do not belong in project configuration or repository files.

## Rate limiting and partial reads

Provider diagnostics contain only the affected surface and a bounded reason code, for example:

```text
provider-rate-limited
provider-timeout
provider-read-failed
provider-invalid-json
pagination-limit-reached
workflow-run-limit-reached
```

The controller can delay a retry based on those codes. It must not bypass settlement because of a provider failure.

## Batch refresh

`refreshBatchGitHubCheckSnapshots(...)`:

1. reads the registered repository from the durable batch;
2. asks the settlement store for the current required SHAs;
3. collects a complete snapshot for each SHA;
4. records each snapshot back into the same batch;
5. returns bounded diagnostics for controller/audit use.

It does not evaluate or mutate the batch state itself. The controller calls the #103 evaluator after snapshot refresh.

## Boundaries

This issue does not:

- receive webhooks;
- create manager authority;
- run triage;
- rerun or cancel workflows;
- approve or merge PRs;
- mutate issues, labels, branches, or checks;
- execute repository commands.

Controller scheduling, hardened transport, triage consumption, and local execution remain separate programme slices.

## Validation

```bash
node --check scripts/ops/agent-runner-github-checks-provider.mjs
node --check scripts/ops/agent-runner-github-checks-provider.test.mjs
node --test \
  scripts/ops/agent-runner-project-registry.test.mjs \
  scripts/ops/agent-runner-event-ingress.test.mjs \
  scripts/ops/agent-runner-event-settlement.test.mjs \
  scripts/ops/agent-runner-github-checks-provider.test.mjs
bash scripts/validate.sh
```
