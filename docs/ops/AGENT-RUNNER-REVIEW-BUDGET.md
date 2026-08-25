# Agent Runner review-budget shadow policy

Issue: #322 `EFFICIENCY.REVIEW.ROUTING.1`

This module is **shadow policy only**. It does not alter the current mandatory CI/review/merge contract and it does not launch a reviewer. Its purpose is to make a future lower-token review path measurable without weakening defect detection before evidence exists.

## Sequence

1. Run required deterministic validation first.
2. If deterministic acceptance is non-terminal, do not spend an independent review call yet.
3. If deterministic acceptance fails, send the bounded failure to implementation correction before any independent review call.
4. Classify exact changed-file scope conservatively. Missing scope is high-risk; missing structured risk cannot establish a cheap low-risk class.
5. High-risk and critical work remains on strong independent review in the shadow plan.
6. A local reviewer is eligible for low-risk shadow selection only when its evidence explicitly says it is **review-qualified**, ready and non-paid. Coding qualification alone is insufficient.
7. Deterministic-only zero-model review is unavailable until separately qualified.
8. Reviewer context is exact-head, diff-first and bounded. Issue history and unrelated repository context are not part of the capsule.
9. Expected CI/review findings for one exact head are coalesced before a correction continuation where safe; a critical finding can wake correction immediately.
10. Old-head findings are not treated as current-head findings.
11. Incremental review evidence is explicitly marked incremental and can never masquerade as a full exact-head approval.

## Risk policy

The source classifier escalates security/authentication, permissions, secrets, credentials, billing, provider/quota/admission, scheduler/controller/manager, migration/database and deployment surfaces to high risk. Source activation, production/release, credential-store and authority-ledger surfaces are treated as critical.

Unknown classification fails conservatively. Free-form worker prose is not an input to this classifier and cannot downgrade review.

## Activation gate

No live review reduction follows from this source slice. Activation requires the shadow/quality evidence required by #322/#194/#298 and must preserve current exact-head acceptance semantics. No paid/API fallback is introduced by the policy.
