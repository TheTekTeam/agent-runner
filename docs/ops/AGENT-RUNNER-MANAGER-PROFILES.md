# Agent Runner management profiles

Issue: `TheTekTeam/agent-runner#259` (`BUILD.MANAGER.PROFILES.1`, parent `#258`).

This is the compatibility-first foundation slice: it defines one versioned,
provider-neutral, schema-validated per-project management profile and a
pure resolver that turns a validated profile into the single bounded
normalized manager context. It does **not** wire profile resolution into
the live management recurrence — that happens in a later, separately
accepted cutover step (see "Publication and cutover" below).

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

## Publication and cutover

This branch only adds the schema, registry, resolver, fixtures and tests.
Enabling profile resolution inside the existing manager recurrence, and
any rollback to the previous manager configuration, are separate
programme actions performed after merge and independent source
activation, per the #259 issue's "Publication and cutover" section.
