# Z790 Claude qualification protocol

Issue: #399 `CLAUDE.WORKER.QUALIFICATION.1`
Parent: #398 `CLAUDE.FLEET.Z790.QUALIFICATION.1` → #328

This protocol reuses the accepted #327/#51 qualification-only worker-job boundary for one purpose only: independently build, execute and accept exactly one Claude Code qualification canary for `claude-code-cli@dev-cluster-z790`, without granting Z790 any scheduler/controller, registry-publication or GitHub-management authority. It is parallel to, and independent from, the accepted Codex #389 path (`AGENT-RUNNER-CODEX-WORKER-QUALIFICATION.md`); the Codex semantics are unchanged.

## Fixed qualification contract

- controller: `dev-cluster-dell`;
- worker: `dev-cluster-z790`;
- adapter instance: `claude-code-cli@dev-cluster-z790`;
- repository: `TheTekTeam/agent-runner`;
- issue: #398;
- model: `sonnet`;
- profile: `narrow`;
- effort: `low`;
- permission mode: `dontAsk`;
- expected mutation: one new `claude-canary.txt`;
- exact content: `AGENT_RUNNER_CLAUDE_CANARY=PASS\n`;
- completion sentinel: `AGENT_RUNNER_CLAUDE_CANARY_COMPLETE`;
- narrow session-usage admission ceiling: 75%.

The contract has a deterministic task fingerprint and protocol fingerprint. Worker requests carrying any other task/model/profile/node/operation identity fail closed.

## Controller build

Dell calls `buildClaudeWorkerQualificationRequest()` with the current accepted worker registry, one manager-authority fingerprint, the exact accepted base SHA, bounded branch/worktree identifiers and request/expiry times. It uses `selectWorkerQualificationRoute()` / `issueWorkerQualificationLease()`; ordinary `selectWorkerRoute()` stays ineligible. The request carries only the protocol schema/fingerprint, one immutable qualification lease and one #327 worker-job envelope.

## Worker validation and execution

`validateClaudeWorkerQualificationRequest()` proves exact Dell/Z790/instance identity, qualification-only lease, exact repository/issue/source identity, exact model/profile, the operation/task fingerprints and the existing #327 lease/worker-job validation.

`executeClaudeWorkerQualificationRequest()` (fixed executable `/usr/bin/claude`, machine-local source/worktree/state roots from the reviewed wrapper) independently proves, before any provider launch:

- exact request/lease/node/registry/source identity and clean `main` at the exact base SHA with the expected origin;
- Claude CLI compatibility via `inspectClaudeCliVersion()` / `inspectClaudeCliHelp()` against the repository minimum (`MINIMUM_IMPLEMENTATION_CLAUDE_VERSION`);
- machine-local first-party `claude.ai` auth for the worker `HOME`, and no inherited provider API-key/token env;
- fresh quota parses (`parseQuotaCheckOutput()`), and narrow admission (`evaluateProfileQuotaAdmission`) is below 75% session usage;
- prompt caching enabled (`inspectClaudePromptCachePolicy`);
- the exact `dontAsk` bounded tool policy (`buildImplementationToolPolicy`) with empty setting sources;
- implementation lane acquired (`acquireImplementationSlot`);
- one-shot state absent.

Exactly one Claude canary then runs through `buildAgentCommandArgs()` (no `--resume`, no user/project setting sources, no web/MCP/GitHub/push/sudo/curl/wget/destructive tools). The bounded `parseClaudeResultEnvelope()` completion sentinel and independent filesystem validation (unchanged HEAD, exactly one expected untracked file with exact content) must agree.

## One-shot / cleanup

- success cleans the temporary worktree and branch before persisting completion;
- provider failure consumes the one-use state once and preserves only bounded forensic workspace evidence;
- a pre-provider refusal creates no provider-consumed state;
- an exact replay returns the persisted result and never invokes the provider twice.

## Evidence contract

Accepted success evidence contains only bounded fields: Claude version; auth method/provider class; session/weekly used percentages; model/profile/effort; permission mode; prompt-cache enabled; tool-policy rule counts and fingerprint; head unchanged; exact expected diff/content; parser/filesystem agreement; branch/worktree cleaned; and the explicit `false` markers for raw prompt / provider output / session id / credential material persistence, credit/balance admission use, and normal routing.

No raw provider output, prompts, account identity, credentials, session IDs or absolute worker secrets appear in returned evidence.

## Command wrapper and restricted transport

```text
npm run qualification:claude-z790 -- <build-request|execute|accept>
```

Mirrors the accepted #199 three-stage controller/worker pattern without a general remote shell.

- **Dell `build-request`** — supplies a bounded snapshot of current #398 manager comments, the expected immutable authority key and packet-body digest, and request/expiry times. It resolves the current canonical manager packet, requires the supplied authority key and digest to still be current, requires `approved_agent: claude-code-cli` and `execution_phase: implementation`, reuses the canonical dispatch-authority resolver for exact repository/branch/base SHA, and proves the Dell checkout is clean `main` at that base SHA with the expected origin. Manager comment bodies are never copied into the worker request.
- **Z790 `execute`** — accepts only the exact request on stdin. `AGENT_RUNNER_CLAUDE_QUALIFICATION_SOURCE_REPOSITORY`, `_WORKTREE_ROOT` and `_STATE_ROOT` supply the trusted machine-local paths; the executable is fixed to `/usr/bin/claude`. Z790 receives no manager comments and performs no GitHub lookup or mutation. Host wiring may select this entrypoint only through an explicit reviewed forced-command change under the permanent restricted #199 Dell→Z790 transport — never as an unrestricted SSH shell.
- **Dell `accept`** — re-snapshots the current issue authority and repeats the manager-authority, canonical dispatch and exact-controller-source checks before calling `acceptClaudeWorkerQualificationResult()`. A superseded/revoked/edited packet, or one that no longer binds the same base/branch/fingerprint, is rejected even if the worker evidence is otherwise valid.

Successful acceptance returns only the bounded per-instance qualification evidence and revision. It does not update the worker registry, enable Claude routing, publish a registry qualification, or merge/close/deploy/source-activate anything. #398 remains the owner of the live field canary and #328 of publishing the accepted `claude-code-cli@dev-cluster-z790` qualification after field proof.

## Field sequence after merge

Before the single allowed provider canary: activate the accepted source on Dell where required; prove Dell is still the sole scheduler/controller; prove Z790 is worker-only and the exact accepted source is clean/current; prove Z790 Claude runtime, machine-local first-party `claude.ai` auth and fresh quota/headroom independently, with no API/paid fallback; publish one fresh immutable #398 manager packet binding the exact canary branch/base/model/profile/effort; build the request on Dell; send only that request through the accepted restricted #199 transport to the Z790 `execute` entrypoint; return only bounded evidence to Dell; re-fetch authority and perform Dell `accept`; only after acceptance, update #398/#328 with the exact Z790 instance qualification. This implementation issue must not run the live #398 field canary.
