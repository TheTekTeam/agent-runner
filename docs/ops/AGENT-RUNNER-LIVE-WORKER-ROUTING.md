# Live worker routing rollout

Issue #327 separates **Dell controller authority** from the exact worker node that executes an admitted implementation lane.

## Compatibility state

With no `AGENT_RUNNER_WORKER_REGISTRY_JSON`, the implementation recurrence preserves the accepted local route:

`<selected-adapter>@dev-cluster-dell`

No remote behaviour is enabled merely by merging the source support.

## Live registry

#405 adds a canonical Dell-owned durable registry at:

`~/.local/state/agent-runner/live-worker-registry.json`

or the exact path named by `AGENT_RUNNER_WORKER_REGISTRY_PATH`.

The durable document is mode 0600, controller-bound to `dev-cluster-dell`, fingerprint-checked and optimistically versioned. Lifecycle mutations require an exact expected revision; stale writes fail closed. Only Dell may mutate it. A symlinked registry file or parent path component is refused.

The repository command is:

`npm run fleet:registry -- inspect`

and, under a separately authorised Dell field workflow, exact-revision `replace` / `transition` operations.

`AGENT_RUNNER_WORKER_REGISTRY_JSON` remains a compatibility/read-only projection when explicitly supplied:

- exactly one controller, which must match `AGENT_RUNNER_LOCAL_WORKER_NODE_ID` (Dell by default);
- bounded node readiness/capacity and worker-only topology;
- positively qualified `agent@node` instances;
- optional exact `registryFingerprint`, which is recomputed and must match when supplied.

Credentials, sessions, prompts, account credit/balance data, arbitrary environment values and unrestricted paths do not belong in either registry form.

When the canonical durable store is present, normal route selection additionally enforces the hard #405 activation invariants:

- only independently accepted exact per-`agent@node` qualification revisions/fingerprints may be represented as qualified;
- Dell qualification evidence gaps remain non-routable;
- lifecycle is independent from qualification and cannot rewrite accepted qualification identity;
- only `included-subscription`, `free` or `local-zero-cost` routes with `paid:false` are eligible;
- included-subscription routes require an explicit provider-account class and cap;
- provider-account capacity is enforced across nodes;
- unknown/metered/paid posture fails closed without any account-credit/balance check;
- a lifecycle transition is refused while that instance reports active work.


The scheduler resolves an exact worker route **inside the existing short Dell selection/admission mutex** and then applies the existing #51 global/repository/agent/instance/node collision and capacity policy to that route.

## Remote fail-closed gate

A remote route requires both:

1. `AGENT_RUNNER_REMOTE_WORKER_DISPATCH_ENABLED=true`; and
2. a reviewed bounded remote transport supplied to the recurrence.

The normal production CLI currently supplies no remote transport. Therefore setting the environment flag alone cannot cause remote execution. If only a remote instance is eligible, the candidate is rejected with `remote-worker-dispatch-not-activated` before provider or repository mutation.

When remote transport is later field-activated, `AGENT_RUNNER_WORKER_NODE_PREFERENCE` may provide a comma-separated bounded node preference. It changes ordering only; it cannot make an unqualified/unhealthy route eligible.

## Evidence

Recurrence evidence records:

- worker-registry fingerprint;
- whether remote routing was actually enabled;
- exact lane-to-`agent@node` route decisions;
- bounded exclusion reasons;
- final per-lane node and agent-instance identity.

No credential material is serialized.

## Remaining field gate

This source seam does not claim two-node completion. Before remote implementation execution is left enabled, #327/#328 still require machine-local provisioning/authentication and per-`agent@node` qualification, a restricted Dell-to-worker transport, exact job/lease validation, provider-account quota coordination, worker reboot/outage proof and supervised Dell+Z790 concurrent execution. Dell remains the sole scheduler/controller throughout.
