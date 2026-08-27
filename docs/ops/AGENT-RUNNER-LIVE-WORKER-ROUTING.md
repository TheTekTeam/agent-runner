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

```text
npm run fleet:registry -- inspect
npm run fleet:registry -- plan --expected-revision <N>
npm run fleet:registry -- promote --expected-revision <N>
npm run fleet:registry -- transition --expected-revision <N> \
  --instance <adapter@node> --state <enabled|paused|draining|disabled> \
  --authority-comment-id <GitHub-comment-id>
```

`plan` is read-only and refuses a stale expected revision. `promote` is Dell-only and derives immutable qualification identity from the repository-owned #401 accepted-evidence publication; the operator supplies bounded current topology/runtime/auth/cost observations only. Promoted instances always start `disabled`. `replace` remains a Dell-only compatibility/administrative path and also requires every instance to be disabled.

Every lifecycle transition is Dell-only and requires a **fresh, current fleet-activation authority** from the configured GitHub control issue. The command does not create authority. It reads the issue and accepts only the latest comment containing exactly one:

`<!-- agent-runner:fleet-activation-authority -->`

packet produced by an allowed normal ChatGPT manager session/scheduled task and authored by a configured implementation approver. The authority is fingerprint-bound to the exact source commit, registry document revision/fingerprint, `agent@node`, target lifecycle state and control issue. The exact comment body digest is persisted as bounded evidence; editing/removing a previously consumed authority causes the next transition to fail closed. Configure the control issue through `AGENT_RUNNER_FLEET_ACTIVATION_CONTROL_ISSUE`; normal GitHub authentication is resolved through the existing bounded `gh` authority path.

A canonical store is deliberately **dormant for production recurrence while remote activation is off**. Merely preparing/promoting lifecycle state therefore cannot replace the accepted Dell-local compatibility route. When remote activation is deliberately requested, production recurrence requires the canonical store and exact activation-source binding before any remote route can become executable. The legacy environment projection may still be read for compatibility, but it cannot activate a remote implementation route.

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

A remote route requires all of:

1. `AGENT_RUNNER_REMOTE_WORKER_DISPATCH_ENABLED=true`;
2. the canonical Dell-owned registry (legacy environment JSON is not activation authority);
3. exact current source commit matching each enabled instance's persisted fleet-activation authority; and
4. a reviewed bounded remote transport supplied to the recurrence.

#405 deliberately supplies no production remote implementation transport; #406 owns that slice. Therefore merging #405, preparing a canonical registry, or setting the environment flag alone cannot cause remote execution. Without the canonical store + valid source-bound lifecycle authority + transport, remote execution remains fail-closed before provider or repository mutation.

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

This source seam does not claim two-node completion. #401 currently publishes exact accepted Claude/Codex qualification only for Z790; Dell qualification records remain explicit evidence gaps and cannot be promoted by this store. #405 does not re-qualify them or invent a Dell route. Before remote implementation execution is left enabled, #327/#328/#402 must still reconcile those field prerequisites, #406's restricted implementation transport, exact job/lease validation, current quota/headroom, reboot/outage/recovery evidence and the required real-route isolation/fall-through proof. Dell remains the sole scheduler/controller throughout.
