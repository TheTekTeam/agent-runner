# Agent Runner accepted-source activation

This runbook describes the repository-owned control-plane contract implemented by #232 and #234. It does **not** itself authorise live enablement.

## Purpose

The source-activation path removes the recurring need for an operator to SSH to the Dell merely to fast-forward the canonical Agent Runner checkout after a reviewed, validated release.

It preserves three separate authority domains:

1. **implementation authority** — `<!-- agent-runner:manager-preflight -->` authorises one bounded implementation attempt;
2. **source-activation authority** — `<!-- agent-runner:source-activation-authority -->` authorises activation of one exact accepted Agent Runner commit;
3. **merge/review authority** — repository review and merge policy decides which source becomes accepted `main`.

These domains are intentionally non-interchangeable:

- a manager-preflight packet can never activate source;
- a source-activation packet can never claim an issue or launch an implementation agent;
- a merge alone is never source-activation authority;
- `origin/main`, the latest release, latest PR or latest comment is never an implicit activation target.

## Live-enable policy

Source-activation automation is disabled unless machine policy explicitly sets:

```text
AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED=true
AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE=<positive GitHub issue number>
```

The control issue number is machine configuration. It must not come from worker/task prose or be selected heuristically.

Optional machine-local state override:

```text
AGENT_RUNNER_SOURCE_ACTIVATION_STATE=<machine-local state file>
```

When omitted, state is stored under the normal Agent Runner user state root. The record is written atomically and forced to mode `0600`.

Do **not** enable this policy merely because #234 is merged. Initial Dell activation and supervised field acceptance remain separate #225 operational gates.

## Immutable GitHub authority schema

A source-activation authority is one approved-manager comment on the configured control issue containing exactly one marker and exactly one YAML block:

```text
<!-- agent-runner:source-activation-authority -->
```

```yaml
schema_version: agent-runner-source-activation/v1
revision: AR-SOURCE-ACTIVATE-2026-08-17.1
target_repository: TheTekTeam/agent-runner
target_branch: main
target_commit: <full-40-hex-accepted-main-sha>
producer_type: normal_chatgpt_manager_session
reason: accepted-main-after-reviewed-merge
fingerprint: sha256:<canonical-material-digest>
```

Permitted producer types are deliberately bounded to the accepted manager surfaces:

- `normal_chatgpt_manager_session`
- `chatgpt_scheduled_task`

The author must also be present in the existing machine-local approved-manager author allowlist. Implementation workers/bots are not made source-activation producers by this feature.

### Fingerprint material

`sourceActivationFingerprint()` hashes the compact JSON serialization of the following keys in this exact order, excluding the `fingerprint` field itself:

```json
{
  "schema_version": "agent-runner-source-activation/v1",
  "revision": "<revision>",
  "target_repository": "TheTekTeam/agent-runner",
  "target_branch": "main",
  "target_commit": "<lowercase-full-40-hex-sha>",
  "producer_type": "<approved-producer-type>",
  "reason": "<bounded-reason>"
}
```

The digest is lowercase SHA-256 prefixed with `sha256:`. The consumer also records the GitHub REST comment ID and a SHA-256 digest of the complete immutable comment body. Editing an already bound comment is therefore an integrity failure, not a silent update.

## Durable consumption state

The controller keeps one positive-allowlisted state record with only bounded identity/result fields:

- schema version;
- configured control issue number;
- source comment ID;
- source authority key (`source-activation:<revision>:<fingerprint>`);
- revision/fingerprint/body digest;
- exact target SHA;
- `pending`, `applied` or `refused` status;
- bounded refusal reason;
- applied timestamp and final HEAD when applied.

The state contains no comment body, token, credential, environment value, remote URL, path from task prose, prompt, Git output or source diff.

`pending` is written **before** invoking the #232 activator. This makes a crash/restart fail closed and retry the same immutable authority instead of selecting a different target.

## Recurrence ordering

When disabled, `bin/run-implementation-recurrence.sh` does not invoke the source-authority controller or perform a GitHub authority lookup.

When enabled, ordering is:

```text
load machine policy
  -> evaluate configured source authority
  -> no authority / already applied: continue
  -> valid new authority: write pending state
  -> invoke #232 exact-SHA activator
  -> write applied state
  -> re-exec canonical wrapper exactly once
  -> strip source-control env from worker inheritance
  -> normal candidate selection / implementation recurrence
```

The outer wrapper evaluates source authority **before** `agent-runner-implementation-recurrence.mjs` acquires the global implementation lock. #232 then acquires/releases that same global lock for the activation transaction, so source cannot be replaced underneath a live worker.

A live lock is a handled deferral: the authority remains pending and no worker is launched during that recurrence. Deterministic source refusal, malformed/ambiguous authority, edited consumed authority, state-integrity failure or GitHub/state uncertainty also prevents worker selection.

## Re-exec guard

Successful first consumption returns a dedicated controller status causing the canonical wrapper to exec itself from the newly activated checkout. A bounded environment depth guard permits exactly one such re-exec. A second re-exec request in the same process chain fails closed.

The guard and all source-activation configuration are removed before normal candidate selection, so implementation workers do not inherit source/deployment-control configuration.

## #232 activation invariants

The accepted #232 primitive remains the only Git checkout mutation implementation. #234 does not duplicate it.

#232 requires:

- non-root execution;
- canonical Agent Runner checkout only;
- branch exactly `main`;
- clean tracked and untracked state;
- existing canonical `origin` remote;
- bounded fetch of `origin main`;
- fetched `origin/main` exactly equals the authorised full SHA;
- current HEAD is an ancestor of target;
- `git merge --ff-only` semantics only;
- exact final HEAD, branch and clean read-back;
- same global implementation lock for the complete transaction;
- bounded mode-`0600` evidence.

It never resets, rebases, cleans, stashes, force-checks out, kills a worker or chooses a moving target.

## Bootstrap and field acceptance

Because a checkout cannot use #234 before it contains #234, one final supervised bootstrap activation is expected after repository acceptance.

The #225 field gate must, at minimum:

1. establish a clean canonical Dell Agent Runner checkout on the accepted source containing #232/#234;
2. leave automation disabled initially;
3. prove #232 positive and negative activation fixtures while the implementation service is quiescent;
4. configure one owner-approved source-activation control issue;
5. create one valid immutable authority for an explicitly accepted target SHA;
6. enable the hook only under the approved operator gate and prove one activation + one re-exec + normal recurrence;
7. prove malformed, edited, ambiguous, dirty/diverged and live-lock cases perform no unsafe source or worker mutation;
8. prove the generic implementation timer remains the sole scheduler and Z790 remains scheduler-free;
9. reboot Dell and repeat state/timer/source integrity checks;
10. leave the feature enabled only if every field gate is green; otherwise revert to disabled policy without deleting forensic state.

Repository CI is not a substitute for this Dell-local field evidence.

## Non-goals

This mechanism does not:

- merge or approve PRs;
- make every `main` push a deployment;
- grant source activation to implementation workers;
- add arbitrary Git/GitHub/shell arguments;
- change scheduler cadence/topology or concurrency;
- change provider, model, quota, budget or billing policy;
- enable paid/API-credit fallback;
- grant scheduler/control authority to Z790;
- deploy ModelSpend/customer production systems.
