# Agent Runner GitHub event ingress

Issue: `TheTekTeam/agent-runner#102`

This is the transport-neutral, read-only event intake boundary for the reusable closed-loop automation programme. It verifies and normalizes signed GitHub webhook deliveries for any repository enabled in the Agent Runner project registry, persists only a bounded event envelope, and returns a deterministic accepted/duplicate result to its caller.

It does not run triage, call a coding agent, mutate GitHub, execute repository commands, or expose a network listener. Hardened HTTPS-to-local transport, service installation and live Dell activation are owned separately by #105.

## Security boundary

- Configure a high-entropy webhook secret outside source control.
- Verify the exact raw request body against `X-Hub-Signature-256` using HMAC-SHA256 and constant-time comparison.
- Use `X-GitHub-Delivery` as the durable idempotency key.
- A replay with identical bounded evidence is acknowledged as a duplicate.
- Reuse of a delivery ID with different payload/repository/event evidence is rejected.
- Accept only enabled repositories and explicitly allowlisted event/action pairs.
- Persist no raw webhook body, issue text, comment text, prompt, token, credential, provider output, or unrestricted payload.
- Keep the default body limit at 1 MiB. Raise it only through bounded machine-local configuration when a required event cannot fit.

GitHub recommends subscribing only to required events, validating `X-Hub-Signature-256`, responding promptly, and using `X-GitHub-Delivery` for replay protection. The core implements those controls without adding a paid service dependency.

## Supported event families

The initial allowlist covers queue and CI state needed by later settlement and triage work:

- issues and issue comments;
- pull requests, reviews, review comments, and review threads;
- check runs and check suites;
- workflow runs and workflow jobs;
- merge groups;
- pushes and commit statuses;
- branch/tag create and delete;
- GitHub App or repository webhook ping.

Unsupported or newly introduced GitHub actions fail closed until reviewed and explicitly added.

## Durable ledger

`EventIngressStore` uses Node's built-in SQLite support and creates:

- `event_ingress_schema`;
- `webhook_deliveries`.

Each delivery stores only:

- delivery ID and timestamps;
- project ID and canonical repository, when applicable;
- event/action;
- issue or PR number where available;
- bounded commit SHA fields;
- processing state;
- SHA-256 of the original raw payload;
- normalized event envelope JSON.

Processing states are `pending`, `batched`, `processed`, and `failed`. Issue #103 consumes pending rows and owns debounce/check settlement. A signed GitHub App `ping` can be recorded without a project or repository so transport setup can be verified before a project event arrives.

## Integration contract

A trusted transport passes:

- the exact raw request body as a `Buffer` or UTF-8 string;
- request headers including `X-Hub-Signature-256`, `X-GitHub-Delivery`, and `X-GitHub-Event`;
- the secret from protected machine-local configuration;
- the loaded project registry;
- an `EventIngressStore` instance.

It calls `acceptGitHubWebhook(...)` and returns a successful response only after the bounded delivery envelope is durably recorded. The transport must not reserialize or alter the request body before signature verification.

## Deployment state

This slice is **shadow-mode ingress core only**. It is not yet a public webhook endpoint and does not make the Dell externally reachable. Issue #105 owns HTTPS ingress, local transport, systemd, secret installation, health checks, firewall/reverse-proxy configuration, reboot survival, and rollback evidence.

## Validation

```bash
node --check scripts/ops/agent-runner-event-ingress.mjs
node --check scripts/ops/agent-runner-event-ingress.test.mjs
node --test \
  scripts/ops/agent-runner-project-registry.test.mjs \
  scripts/ops/agent-runner-event-ingress.test.mjs
bash scripts/validate.sh
```
