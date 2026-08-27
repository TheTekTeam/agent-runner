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

## Command wrapper and restricted transport

The final repository-side #389 slice is exposed through:

```text
npm run qualification:codex-z790 -- <build-request|execute|accept>
```

The command wrapper deliberately mirrors the accepted #199 three-stage controller/worker pattern without creating a general remote shell.

### Dell: `build-request`

Dell supplies only:

- a bounded snapshot of current #389 issue comments containing the manager-authority/status evidence needed for deterministic resolution;
- the exact expected immutable manager authority key;
- the exact expected packet-body digest;
- request and expiry timestamps.

Before producing a worker request, the command:

1. resolves the current canonical manager packet;
2. requires the supplied authority key and packet digest to still be current;
3. requires `approved_agent: codex-cli` and `execution_phase: implementation`;
4. reuses the canonical dispatch-authority resolver for exact repository, branch and base SHA;
5. proves the Dell source checkout is clean `main`, at that exact base SHA, with the expected GitHub origin;
6. builds the already-accepted qualification-only request from PRs #390/#391.

A newer packet, a revoked/already-claimed packet, an edit that changes the packet digest without new authority, wrong agent/phase, source drift or branch/base mismatch fails before any worker or provider execution.

The returned controller metadata contains only bounded authority identity (key, revision, fingerprint, packet digest and comment id). Manager comment bodies are never copied into the worker request.

### Z790: `execute`

Z790 accepts only the exact qualification request on stdin. Machine-local configuration supplies the trusted source repository, worktree root and one-shot state root. The wrapper fixes the Codex executable to `/usr/local/bin/codex`; request or environment input cannot substitute another executable.

The merged executor still owns all pre-provider gates: exact request/source identity, local runtime/auth/quota, zero-model sandbox proof, #51 lane lock, one-shot state and exact canary controls. Z790 receives no manager comments and performs no GitHub lookup or management mutation.

For field activation, reuse the permanent restricted Dell→Z790 transport accepted under #199: dedicated worker identity/key, forced reviewed entrypoint, public-key only, no PTY, no forwarding/tunnel/user RC and no arbitrary command. Host wiring may select this qualification `execute` entrypoint only through an explicit reviewed forced-command change; never expose the command as an unrestricted SSH shell.

### Dell: `accept`

Dell must re-fetch/re-snapshot the current issue authority evidence and call `accept` with the original request/result plus the same expected authority key and packet digest. The command repeats the manager-authority, canonical dispatch and exact-controller-source checks before invoking `acceptCodexWorkerQualificationResult()`.

If the manager packet was superseded, revoked, edited, claimed incompatibly, or no longer binds the same base/branch/fingerprint, the result is rejected even if the worker evidence itself is otherwise valid.

Successful acceptance returns only the bounded per-instance qualification evidence and revision. It does **not** update the worker registry, enable general Codex routing, merge/close/deploy, or source-activate anything. #328 remains the owner of publishing the accepted `codex-cli@dev-cluster-z790` qualification after field proof.

## Field sequence after merge

Before the single allowed provider canary:

1. activate the accepted source on Dell through #263 where required;
2. prove Dell is still the sole scheduler/controller;
3. prove Z790 is worker-only and exact accepted source is clean/current;
4. prove Z790 Codex runtime, Linux sandbox/AppArmor prerequisites and machine-local ChatGPT auth independently;
5. prove current quota/headroom and zero separately-metered/API fallback;
6. publish one fresh immutable #389 manager packet binding the exact canary branch/base/model/profile/effort;
7. build the request on Dell;
8. send only that request through the accepted restricted #199 transport to the Z790 `execute` entrypoint;
9. return only bounded result evidence to Dell;
10. re-fetch authority evidence and perform Dell `accept`;
11. only after acceptance, update #328 with the exact Z790 instance qualification.

No provider/model invocation is permitted until steps 1-6 pass.
