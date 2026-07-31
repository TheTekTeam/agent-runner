# Agent Runner GitHub Event Transport

Issue: `TheTekTeam/agent-runner#105`

This transport exposes the signed event-ingress core from #102 to an existing operator-controlled HTTPS reverse proxy. Agent Runner never binds a public or LAN interface and never accepts arbitrary commands.

## Boundary

The user socket unit owns exactly one listener:

```text
127.0.0.1:8787
```

The Node service accepts only the inherited systemd socket file descriptor. It does not select or bind a host or port itself. The only routes are:

- `GET /healthz` — fixed health response;
- `POST /github/webhook` — signed GitHub webhook intake.

Every other path or method is rejected. Query strings are rejected.

The webhook route:

1. requires exactly one `X-Hub-Signature-256`, `X-GitHub-Delivery` and `X-GitHub-Event` header;
2. reads at most 1 MiB of exact raw request bytes;
3. verifies HMAC-SHA256 through the existing ingress core;
4. resolves the repository through the enabled project registry;
5. accepts only the existing bounded event/action allowlist;
6. durably records the normalized envelope and payload digest;
7. returns `202` only after persistence, or `200` for an exact duplicate replay.

Raw payload bytes, signatures, secret values, issue/comment text and provider output are never logged or returned. Ingress alone does not run queue triage, invoke an agent, mutate a repository or write to GitHub.

## Secret file

Create the webhook secret outside the repository. It must:

- be owned by the service user;
- be a regular file;
- have mode `0600` or stricter;
- contain one value of at least 32 bytes;
- contain no embedded newline or NUL.

The installer validates but never creates, prints or changes the secret.

Example operator action:

```bash
install -d -m 700 "$HOME/.config/agent-runner/secrets"
umask 077
openssl rand -hex 32 > "$HOME/.config/agent-runner/secrets/github-webhook"
chmod 600 "$HOME/.config/agent-runner/secrets/github-webhook"
```

Do not paste the resulting value into GitHub comments, logs, shell history or chat. Enter the same value directly in the GitHub App/webhook secret field during the separate live activation gate.

## Installation

Source installation does not change Nginx, TLS, DNS, firewall or GitHub settings.

```bash
scripts/install-event-ingress-transport.sh install \
  --agent-runner-home /home/gp/projects/agent-runner \
  --project-registry /home/gp/.config/agent-runner/projects.json \
  --controller-db /home/gp/.local/state/agent-runner/controller/controller.sqlite \
  --secret-file /home/gp/.config/agent-runner/secrets/github-webhook
```

The installer:

- validates the checkout, registry and secret permissions;
- backs up any prior service, socket and environment files;
- installs hardened user units;
- writes a mode-0600 environment file containing paths and the body-size limit only;
- reloads user systemd;
- leaves the socket disabled unless `--enable` is explicitly supplied;
- prints the exact backup directory and rollback command.

Add `--enable` only during supervised live acceptance.

## Reverse proxy

Terminate public TLS in the existing operator-controlled Nginx service and proxy only one exact public path to loopback:

```nginx
location = /agent-runner/github/webhook {
    client_max_body_size 1m;
    proxy_http_version 1.1;
    proxy_pass http://127.0.0.1:8787/github/webhook;
    proxy_set_header Host 127.0.0.1;
    proxy_set_header Connection "";
    proxy_request_buffering on;
    proxy_read_timeout 20s;
    proxy_send_timeout 20s;
}
```

Do not add a catch-all proxy location. Do not expose `/healthz` publicly. The reverse proxy must preserve the request body and the three GitHub headers unchanged. Source-IP allowlisting may be added as defence in depth, but it never replaces signature verification.

## GitHub App or webhook subscriptions

Use only the events already allowlisted by `agent-runner-event-ingress.mjs`. Minimum queue/CI coverage is:

- Issues;
- Issue comments;
- Pull requests;
- Pull-request reviews and review comments;
- Check runs and check suites;
- Workflow runs and workflow jobs;
- Merge groups;
- Pushes;
- Commit statuses;
- Branch/tag create and delete.

Subscribe only repositories present in the validated Agent Runner registry. Unknown repositories and unsupported actions fail closed.

## Health and supervised checks

Local health:

```bash
curl --fail --silent --show-error http://127.0.0.1:8787/healthz
```

Expected body:

```json
{"status":"ok","schemaVersion":1}
```

Inspect units without exposing environment values:

```bash
systemctl --user status agent-runner-event-ingress.socket agent-runner-event-ingress.service
systemctl --user show agent-runner-event-ingress.socket -p ActiveState -p SubState -p Listen
systemctl --user show agent-runner-event-ingress.service -p ActiveState -p SubState -p Result
```

For live acceptance, send a GitHub ping and one bounded fixture issue or pull-request event. Verify the delivery appears once in `webhook_deliveries`, a replay remains a duplicate, and no repository/model/queue operation is triggered by ingress alone.

## Missed delivery and redelivery

The existing polling source remains the fallback for missed external webhook delivery. GitHub redelivery reuses the original delivery ID and is idempotent when the payload evidence is unchanged. Reusing a delivery ID with different bounded evidence is a collision and returns `409`.

Do not manually insert webhook rows or replay raw payloads from logs. Use GitHub's native redelivery control or rely on the polling fallback.

## Rollback

Use the exact backup directory printed by the installer:

```bash
scripts/install-event-ingress-transport.sh rollback \
  --backup-dir /home/gp/.local/state/agent-runner/event-transport/backups/TIMESTAMP
```

Rollback stops the new socket/service, restores or removes each installed file according to the manifest, reloads user systemd and restores the prior enabled/active state. It preserves the controller database and delivery evidence.

## Live acceptance still required

Merging the source does not authorise:

- secret creation;
- Nginx, TLS, DNS or firewall changes;
- GitHub App/webhook configuration;
- enabling the socket;
- live event delivery;
- issue closure.

Those require a separate checksum-pinned Dell acceptance with installation, invalid-signature tests, real GitHub ping/event delivery, restart, reboot and rollback proof.
