# Live worker routing rollout

Issue #327 separates **Dell controller authority** from the exact worker node that executes an admitted implementation lane.

## Compatibility state

With no `AGENT_RUNNER_WORKER_REGISTRY_JSON`, the implementation recurrence preserves the accepted local route:

`<selected-adapter>@dev-cluster-dell`

No remote behaviour is enabled merely by merging the source support.

## Live registry

`AGENT_RUNNER_WORKER_REGISTRY_JSON` may contain the bounded #327 worker-registry projection:

- exactly one controller, which must match `AGENT_RUNNER_LOCAL_WORKER_NODE_ID` (Dell by default);
- bounded node readiness/capacity and worker-only topology;
- positively qualified `agent@node` instances;
- optional exact `registryFingerprint`, which is recomputed and must match when supplied.

Credentials, sessions, arbitrary environment values and unrestricted paths do not belong in this registry.

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
