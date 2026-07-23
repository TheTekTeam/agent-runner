# Protected machine-local secret store (issue #45)

Status: **foundation only.** Nothing here is wired into the dashboard,
control API, scheduler, or any adapter's live execution path. See
`TheTekTeam/agent-runner#41` for the security-foundation sequencing this
slice belongs to, and `#5` for the separate reliability/live-activation
gate.

## What this adds

- `scripts/ops/agent-runner-secret-store.mjs` — the protected store itself:
  a restrictive machine-local directory (`0700`) of one `0600` file per
  secret, atomic create/replace/rotate/remove, permission-drift and
  symlink defenses, a non-recoverable per-id write lock, an active-use
  lease that blocks removal, and a safe status surface
  (`configured` / `missing` / `invalid` / `rotation-required`) that never
  returns a value.
- `scripts/ops/agent-runner-secret-reference.mjs` — opaque
  `secretref:<id>` references: the only form a secret is allowed to take
  once it leaves the store and enters non-secret settings, config files,
  GitHub comments, or dashboard payloads.
- `scripts/ops/agent-runner-secret-environment.mjs` — adapter-specific
  allowlisted environment materialization: a caller lists exactly the env
  vars/references it needs and gets back a child-process environment
  containing only those, on top of a caller-supplied base environment.

None of these modules import or modify `agent-runner-agents.mjs`,
`claude-runner-dashboard-api.mjs`, `claude-runner-state.mjs`, or
`agent-runner-manager-authority.mjs`. There is no CLI in this foundation —
nothing here can print, export, or log a value, because no code path exists
that does so.

## Where secrets live

Default path:

```
~/.local/state/agent-runner/secrets/
```

Override with `AGENT_RUNNER_SECRET_STORE_DIR` (absolute, or resolved
relative to `$HOME`), the same override convention used by
`CLAUDE_RUNNER_STATE_DB` and `AGENT_RUNNER_AGENT_SETTINGS_PATH` elsewhere in
this repository. The directory is created at `0700` and re-verified (not
just re-created) on every write; the store never proceeds past a directory
that fails that verification, including one that has been swapped for a
symlink.

Each secret is one file at `<id>.secret.json`, mode `0600`, containing the
value, a self-check `sha256:` digest of the value, and timestamps —
never anything else. `id` is restricted to a short closed
alphanumeric/dash/underscore token (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`,
rejecting `..`), so path traversal is structurally impossible rather than
merely filtered: there is no character `join(dir, id)` could use to escape
`dir`.

## Safe statuses only

`getSecretStatus(dir, id)` and `listSecretStatuses(dir, ids)` return:

| status              | meaning                                                        |
|---------------------|-----------------------------------------------------------------|
| `configured`        | a structurally valid, permission-correct secret is present      |
| `missing`           | no entry exists at this id                                      |
| `invalid`           | present but corrupt, tampered, permission-drifted, or a symlink |
| `rotation-required` | structurally valid but flagged (explicitly, or by expiry) for rotation |

No other function in this foundation returns a value to a general caller.
`readSecretValueForEnvironment()` is the sole raw-value accessor, and it is
only ever called by `agent-runner-secret-environment.mjs` while building a
child process environment — never by anything that could log, serialize,
or display its return value. This is the concrete answer to "secret reads
must not return values through any status or control API": the status API
and the value API are different functions with different, narrow callers,
not one function with a flag.

## Atomic create / replace / rotate / remove, with structural rollback

Every write (`createSecret`, `replaceSecret`, `rotateSecret`) goes through
one atomic path: write a fresh, exclusively-created temp file in the same
directory, `chmod` and re-verify it, then `rename(2)` it onto the
destination. Nothing before the rename touches the destination path at
all, so a failure at any point up to and including the rename call leaves
the prior valid secret exactly as it was — rollback is a structural
property of the write order, not a separate backup-and-restore step. This
is exercised directly in `agent-runner-secret-store.test.mjs` by injecting
a failing `writeFn`/`renameFn` and asserting the prior value is still
readable afterward.

`createSecret` refuses to run if anything (valid, corrupt, or a symlink)
already occupies the id. `replaceSecret`/`rotateSecret` refuse to run
unless a structurally valid secret is already present. A corrupted or
symlinked entry is therefore never silently "fixed" by an ordinary write —
recovery is explicit: `removeSecret` (which safely unlinks exactly the
symlink or corrupt file, never following it) followed by `createSecret`.

`removeSecret` is a no-op success on an already-missing id, and refuses to
run while an active lease is held (see below).

## Concurrency

Each write acquires a per-id lock file (`.{id}.lock`, exclusive create)
before touching anything. A second concurrent writer gets `EEXIST`
immediately and fails closed with `SecretLockedError` — there is no
stale-lock recovery for secrets (unlike the cron lock), so a stuck lock
must be resolved deliberately rather than auto-reclaimed. The lock is
released in a `finally` block, including on a rejected write.

## Removal while active

`acquireSecretLease(dir, id)` / `releaseSecretLease(dir, id)` mark a secret
as currently in use (a `.{id}.lease` file recording pid + timestamp, the
same shape as the existing cron lock). `removeSecret` checks for a live
lease before deleting anything and throws `SecretActiveError` if one is
held by a live process. A lease held by a process that is no longer alive
is treated as stale and reclaimed rather than blocking removal forever.

## Adapter-specific allowlisted environment

```js
import { materializeSecretEnvironment } from './agent-runner-secret-environment.mjs';
import { buildSecretReference } from './agent-runner-secret-reference.mjs';

const result = materializeSecretEnvironment({
  dir: secretStoreDir,
  entries: [
    { envVar: 'AGENT_API_TOKEN', reference: buildSecretReference('agent-token') },
  ],
  baseEnv: { PATH: process.env.PATH }, // explicit — never a default
});
if (!result.ok) { /* fail closed: result.missing explains why, no value anywhere */ }
```

`baseEnv` has **no default**. Omitting it throws
`AGENT_RUNNER_SECRET_ENV_BASE_REQUIRED` — this function never reads or
spreads `process.env` itself, so an operator's ambient shell exports can
never leak into a child process through this path. This is the concrete
answer to "process-environment inheritance" failing closed.

An adapter that needs no secrets passes `entries: []` and gets `baseEnv`
back unchanged. This is how Codex CLI's existing authenticated session
stays compatible: Codex is never forced through this store or an API-key
design, it simply requests zero entries and this function leaves its
environment untouched. Wiring an actual Codex adapter through this
allowlist remains future, separately-scoped work — this foundation only
guarantees the empty-allowlist case does nothing.

Any entry whose secret is `missing`, `invalid`, or `rotation-required`
fails the *entire* materialization closed by default (`result.ok: false`,
`result.env: null`) unless its env var name is listed in
`optionalEnvVars`, in which case it is silently omitted rather than
handed out with a stale/absent value.

## Threat cases covered here

- **Path traversal** — impossible by construction (`validateSecretId`).
- **Absolute or malformed references** — `parseSecretReference` matches
  `^secretref:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` exactly; anything else
  (absolute paths, extra colons, whitespace, wrong prefix) is rejected
  whole, no partial parse.
- **Symlink replacement** — every read and write path `lstat`s (never
  `stat`s) before trusting a path; a symlink at the store directory or at
  a secret path is detected and refused, never followed. Writes replace
  via `rename(2)`, which atomically replaces a symlink destination without
  ever opening/following it.
- **Permission drift** — the store directory is re-verified (and
  re-chmodded) on every write; an individual secret file's mode/owner is
  checked on every read and reported as `invalid` on drift, never silently
  trusted.
- **Partial writes** — a truncated or tampered file fails its digest
  self-check and reports `invalid`; the atomic write path never leaves a
  half-written file at the real destination.
- **Concurrent writes** — a second writer fails closed immediately (see
  Concurrency above).
- **Removal while active** — see above.
- **Process-environment inheritance** — see above.
- **Serialization/logging leakage** — every status-surface return value
  (`getSecretStatus`, `listSecretStatuses`, `verifySecretStoreIntegrity`,
  the `missing` diagnostics from `materializeSecretEnvironment`) is tested
  to never contain a secret value even when `JSON.stringify`'d.

## Backup and recovery

**There is no plaintext export in this foundation, by default, at all** —
not a flag, not a hidden mode. No function in
`agent-runner-secret-store.mjs` returns a batch of raw values, and no CLI
exists to print one. Adding a plaintext export capability is out of scope
for this issue and must be a deliberate, separately authorized, explicitly
opt-in future change — never the default.

To back up the store, treat the whole directory as opaque bytes and
encrypt it in the same pipeline that reads it — never write an
intermediate plaintext archive to disk:

```bash
tar -C "$HOME/.local/state/agent-runner" -cf - secrets \
  | age -r <your-recipient-public-key> -o secrets-backup.age
```

(or `gpg --symmetric` in place of `age` — any tool is fine as long as
plaintext never touches disk between `tar` and encryption).

To restore:

```bash
age -d -i <your-identity-key> secrets-backup.age \
  | tar -C "$HOME/.local/state/agent-runner" -xf -
chmod 700 "$HOME/.local/state/agent-runner/secrets"
```

Then, before trusting the restored store, run
`verifySecretStoreIntegrity(dir, knownIds)` (exported from
`agent-runner-secret-store.mjs`) and confirm every id reports `configured`
or `missing` — never `invalid` — without ever reading a value into the
result. A restore that leaves an entry `invalid` (wrong mode, wrong owner,
corrupt) must be treated as failed and re-attempted, not adopted as-is.
