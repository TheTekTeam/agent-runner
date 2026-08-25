# Deterministic remote validation worker

Issue: #199 `Z790.REMOTE.VALIDATION.1`  
Parent: #196 `Z790.ACCELERATOR.1`

## Authority boundary

Dell remains the sole Agent Runner scheduler/controller. The deterministic remote-validation path gives a worker node permission to execute **one already-authorised validation request only**. It does not give the worker issue selection, issue claim, manager-authority, GitHub mutation, merge/close/deploy, source-activation, provider/model invocation or scheduler authority.

The source contract is implemented by:

- `scripts/ops/agent-runner-remote-validation.mjs`;
- `scripts/ops/agent-runner-remote-validation-command.mjs`;
- `npm run validation:remote -- <build-request|execute|accept>`.

This contract is node-capability based. Deterministic validation does **not** create a fake Claude/Codex/Ollama agent instance merely to use a worker machine.

## Three bounded operations

### 1. Dell: `build-request`

Dell supplies a small JSON object on stdin containing only:

- target node id;
- project id and registered `owner/repo` identity;
- exact commit SHA and exact Git tree SHA;
- allowlisted validation profile id;
- non-secret controller authority fingerprint/revision;
- request and expiry timestamps.

The command binds those values to the current worker-registry fingerprint, exact node capability fingerprint, toolchain fingerprint and the repository-owned validation-profile contract. It returns one deterministic `jobFingerprint`.

The request never contains argv, shell text, filesystem paths, environment values, credentials or provider/model instructions. Unknown fields fail closed.

### 2. Worker: `execute`

The worker receives only the request JSON on stdin. Machine paths come from local configuration, never from the request:

- `AGENT_RUNNER_REMOTE_VALIDATION_SOURCE_REPOSITORY` — trusted local Git object/source repository;
- `AGENT_RUNNER_REMOTE_VALIDATION_WORKTREE_ROOT` — dedicated disposable validation-worktree root;
- `AGENT_RUNNER_REMOTE_VALIDATION_STATE_ROOT` — machine-local exact-job replay records;
- `AGENT_RUNNER_NODE_ID` — exact executing node identity;
- `AGENT_RUNNER_CONTROLLER_NODE_ID` — expected Dell controller identity;
- existing `AGENT_RUNNER_WORKER_REGISTRY_JSON` — current bounded worker registry.

Before any validation command executes, the worker proves:

1. the request fingerprint and authority window are valid;
2. the request is for this exact worker-only node;
3. current registry/node/toolchain fingerprints still match;
4. the requested validation profile is locally allowlisted and its contract fingerprint is unchanged;
5. the exact commit exists in the trusted local repository;
6. the exact Git tree equals the request;
7. a derived, collision-free detached Git worktree can be created at that exact commit;
8. the worktree is clean and at the exact requested commit/tree.

Only argv arrays stored in the repository-owned profile may execute. `shell:false` is mandatory. The request cannot add or alter commands.

Child processes inherit only a fixed positive allowlist of harmless runtime variables (`PATH`, `HOME`, locale, `CI`, `NO_COLOR`). Provider/API/session variables are not inherited. No unrestricted environment dump is returned.

After execution, the worker re-verifies exact commit, exact tree and clean worktree state. A clean exact worktree is removed through ordinary `git worktree remove`; no `--force`, reset, clean, stash or rebase recovery is provided. Drift or unsafe cleanup fails closed.

The result contains only identity, timing, status/exit class, byte counters and SHA-256 output digests. It contains no raw stdout/stderr, prompt/provider output, credential, local path or arbitrary diagnostic text.

### 3. Dell: `accept`

Dell independently revalidates the original request against its current worker registry/profile contract and accepts a result only when all of the following remain exact:

- job/controller/registry identity;
- worker node and capability fingerprint;
- toolchain fingerprint;
- project/repository;
- observed commit SHA and tree SHA;
- validation profile/revision/contract fingerprint;
- resource class;
- result fingerprint and idempotency key;
- authority time window;
- `status=succeeded`, `exitCode=0`, no error code.

Missing, malformed, expired, failed, partial, wrong-SHA/tree/node/profile/toolchain or tampered evidence is never converted into success.

## Replay / idempotency

A repository-owned profile may opt into exact-job replay. Successful results are written as mode-0600 machine-local records keyed only by the deterministic job fingerprint. A repeated request may return the same already-accepted result fingerprint without re-executing commands.

This is not the broader content-addressed work cache owned by #195/#200. Failed jobs are not persisted as reusable successes, and a replay-record collision or invalid record fails closed.

## Transport boundary

This source slice deliberately does **not** implement general SSH execution.

For field activation, Dell may use SSH/Tailscale only if the Z790 key/account is restricted to this reviewed worker entrypoint (for example a forced command invoking only `npm run validation:remote -- execute` with request JSON on stdin), with forwarding, PTY, arbitrary command and unrestricted shell access disabled for that credential.

The transport must not permit the request to choose another executable, command line, repository path, worktree root or state root.

## Resource limits

The source contract enforces:

- per-command timeouts;
- total profile duration contract;
- per-command output-buffer bounds;
- bounded request/result size;
- isolated detached worktree scope.

Host-level CPU/RAM/disk/cgroup limits are a **field-activation gate** for #199 and must be applied by the reviewed Z790 service/forced-command wrapper where supported. Do not mark #199 complete merely because source CI passes.

## Z790 field acceptance

After this source is merged and activated:

1. configure the restricted worker entrypoint on Z790 without scheduler authority;
2. retain the accepted Z790 kernel baseline `7.0.0-28-generic`; this is intentional because `7.0.0-30` caused NIC-speed regressions on this host;
3. Dell builds one request for exact current Agent Runner main and its exact tree;
4. Z790 executes the `agent-runner-canonical` profile in the isolated detached worktree;
5. Dell independently accepts the returned result;
6. repeat the exact request and prove replay does not re-execute validation;
7. induce wrong-SHA/tree and tampered-result fixtures and prove refusal;
8. prove provider/API environment values do not cross the worker boundary;
9. make Z790 unavailable and prove Dell queue/control safety is unchanged;
10. leave remote validation enabled only when host resource limits and all field gates are green.

## Non-authority invariants

The remote-validation worker never:

- polls/selects/claims GitHub issues;
- authors or consumes manager authority on its own initiative;
- mutates GitHub issue/PR state;
- launches Claude, Codex, Grok, Ollama or another provider/model;
- merges, closes, deploys or source-activates;
- runs Agent Runner scheduler recurrence;
- steals/reassigns active work;
- accepts arbitrary shell strings or request-controlled paths.
