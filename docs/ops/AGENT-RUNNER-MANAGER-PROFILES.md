# Agent Runner management profiles

Issue: `TheTekTeam/agent-runner#259` (`BUILD.MANAGER.PROFILES.1`/`.2`/`.3`, parent `#258`).

This is the compatibility-first foundation slice: it defines one versioned,
provider-neutral, schema-validated per-project management profile and a
pure resolver that turns a validated profile into the single bounded
normalized manager context. Profile resolution is wired into the one
existing implementation recurrence (`agent-runner-implementation-recurrence.mjs`)
as a **read-only shadow** only — see "Read-only shadow wiring" below. It does
**not** yet make the profile-resolved context authoritative over selection,
claim or dispatch; that cutover happens in a later, separately accepted step
(see "Publication and cutover" below).

## What this is not

- Not a manager-authority generator. `<!-- agent-runner:manager-preflight -->`
  packet parsing, claim identity and dispatch authority are unchanged; see
  `docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-CODE-MAP.md`.
- Not a second manager, scheduler or shell surface.
- Not a repository-discovery or cloning mechanism. Every profile is an
  explicitly registered, checked-in fixture file.
- Not a place for secrets, credentials, prompts, raw provider output, local
  absolute paths or environment values.
- Not a place for any account-credit or balance field; the schema and
  registry both refuse profiles that carry one.

## Modules

- `scripts/ops/agent-runner-manager-profile-schema.mjs` —
  `validateManagerProfile()` fails closed on unknown fields, missing
  required fields, malformed repository/branch/control-issue shapes and
  unsafe mutation-capability combinations (e.g. `deploy` without `merge`).
  It also fails closed on any `labels` key outside a fixed, exact set of
  supported label-state names, any label/capability value that does not
  match a safe lowercase syntactic pattern, duplicate label values or
  duplicate capabilities, and recursively refuses an account-credit or
  balance style field name anywhere in the profile, at any nesting depth
  (not merely at the top level). Every object it returns is registered in
  an internal `WeakSet`, so `assertNormalizedManagerProfileShape()` (used by
  `resolveManagerContext()`) can refuse an adversarial object that merely
  *replicates* a validated profile's exact frozen shape and values but was
  never actually produced by `validateManagerProfile()` -- profile
  provenance is unforgeable, not just shape-checked.
- `scripts/ops/agent-runner-manager-profile-registry.mjs` — the explicit
  `MANAGER_PROFILE_REGISTRY` list and `resolveRegisteredManagerProfile()`,
  which fails closed for an unregistered `projectId` or a repository that
  does not exactly match the profile's declared `owner/repository`.
- `scripts/ops/agent-runner-manager-context.mjs` — `resolveManagerContext()`
  is a pure function from a validated profile to the normalized manager
  context. A profile with `enabled: false` always resolves to a context
  whose mutation authority and mutation bounds are entirely zero/false,
  regardless of what the raw profile's `mutationAuthority` block declares.

## Registered profiles

| projectId | repository | enabled | fixture file |
| --- | --- | --- | --- |
| `agent-runner` | `TheTekTeam/agent-runner` | `true` | `config/manager-profiles/agent-runner.json` |
| `modelspend` | `TheTekTeam/modelspend` | `true` | `config/manager-profiles/modelspend.json` |
| `fixture-third-project` | `TheTekTeam/example-docs-site` | `false` | `config/manager-profiles/fixture-third-project.json` |

`agent-runner` and `modelspend` both authorise only `issueMutation` and
`authorityIssuance` (comment/packet posting). `merge`, `close`, `deploy`
and `sourceActivation` are `false` for both, matching the current
supervised-merge recurrence where a human reviews and merges the draft PR.

`fixture-third-project` is a disabled, read-only fixture for a materially
different project shape (fixed control issue instead of a label selector,
a `release` default branch, a different label scheme and capability
allowlist). It proves the schema/resolver generalise without any
Agent Runner source-code special casing. It is never enabled, cloned or
contacted.

## Minimum profile fields

Every profile is validated against the fields listed in issue #259:
`schemaVersion`, `projectId`, `enabled`, `repository` (`owner`/`name`),
`branches` (`allowed`/`default`), `objective`, `nonGoals`,
`instructionPaths`, `controlIssue` (`fixedIssue` or `labelSelector`
mode), `labels`, `capabilities.allowlist`, `validation`
(`profile`/`requiredChecks`), `quotaPolicyRef`, `mutationBounds`,
`escalation.rules`, and the `mutationAuthority` booleans
(`issueMutation`, `authorityIssuance`, `merge`, `close`, `deploy`,
`sourceActivation`).

## Read-only shadow wiring

`scripts/ops/agent-runner-manager-profile-shadow.mjs` compares each enabled
canonical registry project's profile-resolved manager context against its
real registry identity **field by field**, and
`agent-runner-implementation-recurrence.mjs` records the result on every
tick as a `profileShadow` evidence field. This is diagnostic only:

- It runs after `selectRunnableProject()` has already chosen (or not
  chosen) a project, so it can never influence selection, probing or
  invocation.
- Any failure inside it (missing profile, registry load error, mismatch) is
  captured as a bounded result and never thrown, so it can never block or
  alter the real recurrence.
- `computeManagerProfileShadow()` binds `loadManagerProfileRegistry()`
  against the *whole* canonical managed-project set it was given (every
  enabled project the real recurrence just probed), not a second,
  independently reloaded copy of the registry. It fails the shadow
  computation closed (a bounded `available: false` evidence result, never
  thrown) if an enabled manager profile cannot be matched against that
  exact canonical set — see
  `agent-runner-manager-profile-registry.mjs#assertManagerProfileRegisteredInProjectRegistry`.
- For each project, every behaviour-affecting field expressible by both the
  canonical project config and the normalized profile is compared
  independently: `projectId`, `repository`, `enabled`/admitted state,
  `branches` (allowed/default) and `instructionPaths`. A field the
  canonical config does not currently carry (the config schema has no
  per-project `branches`/`instructionPaths` field yet) is recorded in a
  `nonComparable` evidence list rather than silently treated as a match, so
  the gap itself is visible evidence.

## Publication and cutover

This branch adds the schema, registry, resolver, fixtures, read-only shadow
wiring and tests. Making profile resolution authoritative over selection,
claim or dispatch inside the existing manager recurrence, and any rollback
to the previous manager configuration, are separate programme actions
performed after merge and independent source activation, per the #259
issue's "Publication and cutover" section.
