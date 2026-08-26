# Cross-node deterministic work cache

Issue: #200 `Z790.CACHE.WORKER.1`  
Parent contract: #195 `VALIDATION.WORK.REUSE.1`

## Purpose

Dell and Z790 may reuse only deterministic work already classified `reusable` by #195. Cross-node reuse never turns cached history into fresh terminal evidence and never grants scheduler, provider, GitHub mutation or source-activation authority to a worker.

The source contract is implemented by:

- `scripts/ops/agent-runner-deterministic-work-cache.mjs` — machine-local content-addressed cache;
- `scripts/ops/agent-runner-cross-node-work-cache.mjs` — portable producer/consumer-bound envelope;
- `scripts/ops/agent-runner-cross-node-work-cache-command.mjs`;
- `npm run cache:cross-node -- <export|consume>`.

## Portable envelope

An exported envelope contains only:

- the normalized #195 descriptor and deterministic cache key;
- the allowlisted successful result (`outputDigest`, optional bounded result class and primitive counters);
- producer node id and capability fingerprint;
- producer toolchain/platform fingerprint;
- explicit compatibility class (`exact-platform` or `host-independent`);
- original cache creation timestamp;
- a SHA-256 envelope integrity digest.

It contains no raw stdout/stderr, prompt/provider output, credential/session data, environment dump, machine-local cache path, HOME path or mutable checkout contents.

Descriptors selected for cross-node transfer receive extra sink-safety checks. The command must be a simple reviewed executable identity; absolute paths, parent traversal and obvious credential/token material in argv/input identities are refused before export.

## Consumer binding

A valid producer envelope is not sufficient by itself. The consumer supplies machine-local identity through configuration, never through the envelope request:

- `AGENT_RUNNER_NODE_ID`;
- `AGENT_RUNNER_NODE_CAPABILITY_FINGERPRINT`;
- `AGENT_RUNNER_TOOLCHAIN_FINGERPRINT`;
- `AGENT_RUNNER_PLATFORM_FINGERPRINT`.

The consumer recomputes the #195 cache key, descriptor normalization and envelope integrity before reuse.

For `exact-platform` entries, consumer toolchain and platform fingerprints must both match. For explicitly `host-independent` entries, platform may differ but the exact toolchain fingerprint still must match. A successful decision emits a new `reuseFingerprint` bound to producer capability, consumer capability, exact cache key and compatibility class.

This reuse evidence is what a higher-level validation/provenance record should persist. It does not claim a fresh run occurred.

## Command boundary

`npm run cache:cross-node -- export` accepts exactly:

```json
{"descriptor": {}}
```

`npm run cache:cross-node -- consume` accepts exactly:

```json
{"descriptor": {}, "envelope": {}}
```

The cache root is machine-local (`AGENT_RUNNER_CROSS_NODE_CACHE_ROOT`, or the normal local deterministic-work cache root). Stdin cannot choose a cache path, node identity, executable, shell command or environment value. Input and envelope sizes are bounded.

## Freshness boundary

`fresh-required` work is never exported. Cross-node cache reuse must never satisfy:

- exact-head CI requiring a fresh run;
- security/auth/credential smoke;
- provider canary;
- Dell/Z790 field acceptance;
- reboot/service/timer proof;
- current-runtime performance benchmarks;
- any validation profile whose accepted policy requires fresh execution.

Deletion, corruption, incompatibility or transport outage therefore causes a cache miss/performance loss only; correctness must fall back to fresh execution.

## Field transport

The portable envelope deliberately does not require a shared mutable filesystem or arbitrary SSH shell.

For #200 field acceptance, prefer a dedicated **internal-SFTP-only cache exchange identity** over the Dell↔Z790 LAN/Tailscale path:

- separate from the #199 `agentval` validation credential;
- `ForceCommand internal-sftp` (or equivalent `internal-sftp` subsystem restriction);
- no PTY, port forwarding, agent forwarding, X11 forwarding or shell;
- a root-controlled bounded exchange directory outside source checkouts and outside either user's HOME/session directories;
- only envelope files, never `node_modules`, repositories, worktrees, provider credentials or raw command output;
- bounded retention and deletion where cache loss affects performance only.

The field setup must prove the SFTP identity cannot obtain a shell or access paths outside the exchange root. Do not widen the already-accepted #199 remote-validation credential into a general file-transfer account.

### Z790 central `AuthorizedKeysFile` ownership rule

Z790's OpenSSH privilege-separated authentication path has a proven machine-specific requirement for dedicated service identities that use `AuthorizedKeysFile /etc/ssh/authorized_keys/%u`:

- keep `/etc/ssh/authorized_keys` itself root-controlled (`root:root`);
- make each per-user leaf key file owned by the matching target service account and group, mode `0600` — for example `agentval:agentval 0600` or `agentcache:agentcache 0600`;
- **do not provision the leaf as `root:root 0600`**: on this node the target-user pre-auth process cannot read it and sshd fails with `Could not open user '<user>' authorized keys ... Permission denied`;
- do not compensate by weakening the parent directory, making the leaf broadly readable, disabling `StrictModes`, or widening shell/forwarding/password authority;
- provisioning/recovery scripts must verify the parent ownership, leaf ownership/mode, `sshd -t`, effective `sshd -T -C ...` policy, and a real restricted public-key authentication test before claiming the transport works.

This rule was first proven during #199 `agentval` field acceptance and applies equally to new dedicated identities such as #200 `agentcache`. Reuse this proven ownership pattern rather than rediscovering the same failure for each new restricted SSH/SFTP identity.

## Required field proof

After source acceptance:

1. create one reusable deterministic fixture on Z790;
2. export its bounded envelope with exact Z790 capability identity;
3. transfer only that envelope through the restricted exchange path;
4. consume it on Dell with exact consumer capability/toolchain identity;
5. record the resulting producer/consumer-bound `reuseFingerprint`;
6. mutate one material descriptor input and prove a miss;
7. alter platform/toolchain compatibility and prove refusal;
8. tamper/corrupt the transferred envelope and prove rejection;
9. delete the envelope/cache and prove the same fixture still succeeds by fresh execution;
10. compare cached vs fresh wall time only for materially identical workloads;
11. remove temporary field fixtures and leave no fake provider/scheduler route behind.

Dell remains the sole scheduler/controller throughout.
