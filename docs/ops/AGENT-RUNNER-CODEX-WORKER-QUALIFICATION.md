# Z790 Codex qualification protocol

Issue: #389 `CODEX.FLEET.Z790.QUALIFICATION.1`  
Parent: #328 `AGENT.FLEET.PROVISIONING.1`

This protocol extends the accepted #327 worker-job boundary for one purpose only: independently qualify `codex-cli@dev-cluster-z790` without granting Z790 any scheduler/controller or GitHub management authority.

## Fixed qualification contract

The v1 contract is intentionally narrow:

- controller: `dev-cluster-dell`;
- worker: `dev-cluster-z790`;
- adapter instance: `codex-cli@dev-cluster-z790`;
- repository: `TheTekTeam/agent-runner`;
- issue: #389;
- model: `gpt-5.6-terra`;
- profile: `codex-canary-v1`;
- effort: `low`;
- expected mutation: one new `codex-canary.txt`;
- exact content: `AGENT_RUNNER_CODEX_CANARY=PASS\n`;
- sandbox: `workspace-write`;
- approval policy: `never`;
- network: disabled;
- Codex execution: ephemeral;
- ambient user/project Codex config: ignored.

The contract has a deterministic task fingerprint and protocol fingerprint. Worker requests carrying any other task/model/profile/node/operation identity fail closed.

## Controller build

Dell calls `buildCodexWorkerQualificationRequest()` with:

- the current accepted worker registry;
- one manager-authority fingerprint;
- exact accepted base SHA;
- exact bounded branch/worktree identifiers;
- request/expiry times.

The builder uses the qualification-only lease seam accepted in PR #390. The Z790 instance may still be `qualified:false`, but it must already be enabled, ready, authenticated and have available capacity. Ordinary `selectWorkerRoute()` remains ineligible.

The resulting request contains only:

- protocol schema/fingerprint;
- one immutable qualification lease;
- one standard #327 worker-job envelope.

It grants no model invocation by itself.

## Worker validation

`validateCodexWorkerQualificationRequest()` consumes the normal worker registry plus the request and proves:

- exact Dell controller identity;
- exact Z790 worker identity;
- exact `codex-cli@dev-cluster-z790` instance;
- qualification-only lease;
- exact repository/issue/source identity;
- exact model/profile;
- exact operation/task fingerprints;
- existing #327 lease and worker-job fingerprint validation;
- unexpired authority;
- current registry/capability/instance fingerprints.

The protocol module contains no subprocess execution, GitHub access, scheduler logic, queue selection, manager-authority production, source activation, merge/close/deploy action or arbitrary remote shell.

## Worker result

A later worker executor must construct its terminal result through `buildCodexWorkerQualificationResult()`.

Successful evidence is allowlisted and must prove:

- bounded Codex version;
- ChatGPT auth;
- primary and secondary quota remaining percentages;
- exact model/profile/effort;
- workspace-write / approval-never / network-disabled controls;
- ephemeral execution and ignored ambient config;
- unchanged HEAD;
- exact expected diff/content;
- parser/filesystem mutation agreement;
- branch/worktree cleanup;
- no raw prompt/provider/credential persistence;
- credits not used for admission;
- normal catalogue remains disabled.

Unsafe, additional, malformed or incomplete evidence is rejected.

## Controller acceptance

Dell calls `acceptCodexWorkerQualificationResult()`. Acceptance requires:

1. the original request still validates against the current registry;
2. standard #327 result identity/fingerprint validation passes;
3. result source SHA is still the exact dispatched base;
4. result is successful with exit 0;
5. safe evidence is present, untruncated and exactly conforms to the qualification evidence schema.

Acceptance returns a bounded qualification revision but does **not** mutate the registry or enable routing. A later #328 step must deliberately publish the accepted per-instance qualification before normal routing can consider it.

## Control surface

The worker side has no:

- scheduler;
- queue selection;
- manager-authority;
- GitHub management mutation;
- merge/close/deploy;
- source activation;
- arbitrary shell;
- automatic routing enablement.

The next #389 slice will implement the local Z790 Codex executor against this accepted protocol and must preserve every boundary above.
