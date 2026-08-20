# Code review fallback policy

Status: standing programme-management policy for ModelSpend / Agent Runner work.

## Rule

When an otherwise-required Codex code review cannot run because Codex code-review credits, quota, or review capacity are exhausted, the programme-management coordinator must perform a rigorous read-only code review directly rather than blocking progress, requesting paid capacity, or treating the unavailable Codex review as a pass.

The self-review must:

- review the exact PR head or, if already merged, the exact merged code;
- reconcile the implementation against the governing GitHub issue, repository rules, security boundaries, acceptance criteria and current CI evidence;
- inspect the changed code plus any adjacent runtime/security/rollback paths necessary to assess correctness;
- classify and record any blocking findings before merge or further field activation;
- require exact-head CI/validation gates that would otherwise apply;
- state explicitly that the review was performed by the programme-management coordinator and is not an independent Codex review.

If the self-review finds no blocking defect and all other required repository and field gates are green, lack of Codex review credits/capacity alone must not block progress.

## Non-exceptions

This fallback does not waive human approvals, deployment/production gates, merge authorisation, security boundaries, tenant isolation, field acceptance, exact-SHA validation, or any other repository-specific stop condition. It replaces only an unavailable Codex code-review step caused by exhausted review capacity.
