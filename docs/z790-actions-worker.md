# Z790 GitHub Actions build-worker runbook

Issue: #198 `Z790.ACTIONS.VALIDATION.1`

## Authority boundary

`dev-cluster-dell` remains the sole Agent Runner scheduler/controller. The Z790 is a **worker only**. GitHub Actions on Z790 may check out an exact repository revision and run deterministic source validation. It must not claim issues, create manager authority, mutate the queue, merge/close pull requests, deploy, activate Agent Runner source, or become an Agent Runner scheduler.

The repository field workflow is `.github/workflows/validate-z790.yml`. It remains `workflow_dispatch`-only as a bounded field/diagnostic surface. After the accepted #198 field proof on 2026-08-25, canonical PR/push validation is routed to the same positively qualified Z790 `build-worker` capability through `.github/workflows/validate.yml`.

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

## Accepted field evidence

On 2026-08-25 the Z790 field acceptance was executed against exact Agent Runner main `ce1a7da8dc873f24b9b3e7e75d59c1389e828717`.

Bounded accepted evidence:

- pre-reboot workflow run `32872485693`, job `97882594702`;
- post-reboot workflow run `32873112001`, job `97884604386`;
- both jobs executed on runner `dev-cluster-z790` with labels `self-hosted`, `dev-cluster-z790`, `build-worker`;
- both exact-head canonical validation jobs concluded `success` in approximately 40 seconds;
- accepted Dell baseline was approximately 62 seconds for the canonical validation step and 69–70 seconds for the whole job;
- Z790 became unavailable during the reboot proof and returned with its Actions service enabled/active;
- no Agent Runner scheduler/controller units were present on Z790 before or after reboot;
- Dell remained independently available during the Z790 outage.

GitHub did not project the Z790 runner offline before the host returned during this reboot cycle, so the host SSH outage is the positive machine-unavailability evidence for that cycle.

The Dell operator-status projection separately reported its existing fail-closed `state-db-missing` condition during the same observation. That condition is not caused by Z790 and is not evidence that Z790 owns or affects Dell control state.

## Ongoing validation

The manual **Validate Agent Runner on Z790** workflow remains available for bounded exact-head field checks. Record only bounded evidence:

- workflow run ID;
- exact commit SHA;
- job runner name and labels proving Z790 execution;
- conclusion;
- job/validation wall time.

Canonical `.github/workflows/validate.yml` must remain read-only source validation and capability-bound to `self-hosted`, `dev-cluster-z790`, `build-worker`. Any future change that would add issue mutation, deployment, provider credentials or Agent Runner scheduler/controller authority requires separate reviewed authority.

## Outage semantics

An unavailable Z790 may delay canonical CI capacity. It must not affect queue ownership, Dell manager authority, Agent Runner correctness, issue state or source activation. Dell remains the sole scheduler/controller; Z790 remains replaceable execution capacity.
