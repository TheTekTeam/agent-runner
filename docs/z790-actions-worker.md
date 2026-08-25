# Z790 GitHub Actions build-worker runbook

Issue: #198 `Z790.ACTIONS.VALIDATION.1`

## Authority boundary

`dev-cluster-dell` remains the sole Agent Runner scheduler/controller. The Z790 is a **worker only**. GitHub Actions on Z790 may check out an exact repository revision and run deterministic source validation. It must not claim issues, create manager authority, mutate the queue, merge/close pull requests, deploy, activate Agent Runner source, or become an Agent Runner scheduler.

The repository field workflow is `.github/workflows/validate-z790.yml`. It is deliberately `workflow_dispatch`-only until field acceptance proves the runner is registered, labelled and recoverable. Canonical PR/push validation remains on Dell during this proof phase.

## Required runner identity

Register or reconfigure the self-hosted GitHub Actions runner on Z790 with all of these labels:

- `self-hosted`
- `dev-cluster-z790`
- `build-worker`

Registration credentials and runner service credentials are machine-local secrets. Do not paste them into issues, PRs, logs, repository files, Agent Runner configuration, or another node. Obtain a fresh registration token through the normal GitHub repository/organisation runner setup UI only when registration is actually required.

## Pre-field checks on Z790

Before dispatching the field workflow, positively verify on Z790:

1. the Actions runner service is installed and healthy;
2. the runner carries the exact required labels above;
3. Node/toolchain prerequisites required by the workflow are available or can be installed by the standard GitHub actions;
4. no Agent Runner scheduler/timer/controller service is installed or enabled on Z790;
5. no Dell scheduler state, provider credential file, session file or controller database has been copied to Z790.

Do not infer readiness merely because the repository contains this workflow.

## Field acceptance

Dispatch **Validate Agent Runner on Z790** against the exact target commit. Record only bounded evidence:

- workflow run ID;
- exact commit SHA;
- job runner name and labels proving Z790 execution;
- conclusion;
- job/validation wall time;
- comparison to the accepted Dell baseline when materially comparable.

Accepted pre-change Dell baseline recorded on #198 is approximately 62 seconds for the canonical validation step and 69–70 seconds for the whole job. This is a reference, not a promised Z790 speedup.

Then reboot Z790 and prove the Actions worker returns without any Agent Runner scheduler authority. Finally prove Dell queue/controller behaviour remains safe while Z790 is unavailable.

## Canonical cutover gate

Only after the field evidence above is accepted should `.github/workflows/validate.yml` be changed from `dev-cluster-dell` to the positively qualified Z790 `build-worker` labels. Until then, an unavailable Z790 can block only the manual field workflow; it cannot block ordinary repository CI or Agent Runner correctness.
