# Agent Runner control-service hardening compatibility

Status: repository-owned compatibility note for `agent-runner-control.service` under issue #174.

## Field evidence

Dell field activation on 2026-08-20 with `/usr/bin/node` 22.23.2 proved that the original combination of:

- `MemoryDenyWriteExecute=true`;
- `Environment=NODE_OPTIONS=--jitless`; and
- `ExecStart=/usr/bin/node --jitless ...`

is incompatible with the approved control-service runtime.

The service successfully bound `127.0.0.1:8789`, then Node's built-in Undici HTTP implementation attempted to initialise its WebAssembly-backed llhttp parser. Because `--jitless` disables WebAssembly, the process exited with `ReferenceError: WebAssembly is not defined`. Systemd retried once and reproduced the same failure. The repository installer then rolled the fresh installation back cleanly; event ingress on 8787 and the implementation/event-polling topology remained unchanged.

## Approved exception

Issue #174 requires `MemoryDenyWriteExecute=true` only where compatible. It is therefore intentionally omitted for the Node 22.23 control service, together with the `--jitless` workaround that made it unusable.

The repository installer rejects either `--jitless` or any `MemoryDenyWriteExecute=` directive if they are reintroduced into the rendered control unit.

This exception does **not** change the loopback-only network contract, authentication/session semantics, writable paths, scheduler isolation, provider/quota behaviour, or any control API behaviour.

## Hardening retained

The service continues to require the compatible controls, including:

- `NoNewPrivileges=true`;
- `PrivateTmp=true`;
- `ProtectSystem=strict`;
- `ProtectHome=read-only`;
- read-only Agent Runner state with only the existing explicit config/secret/audit write carve-outs;
- `RestrictAddressFamilies=AF_UNIX AF_INET`;
- `LockPersonality=true`;
- `RestrictRealtime=true`;
- `RestrictSUIDSGID=true`;
- `UMask=0077`;
- bounded `TasksMax`, `MemoryMax`, restart and timeout settings;
- no environment file, embedded credentials, capabilities, public/LAN bind, or host override.

The fixed production CLI remains `127.0.0.1:8789` by default and continues to reserve 8787 for event ingress.

## Acceptance consequence

This compatibility exception is accepted only if exact-head repository validation remains green and Dell field acceptance proves all of the following simultaneously:

1. the service remains continuously active with `NRestarts=0`;
2. exactly one control listener exists at `127.0.0.1:8789`;
3. event ingress remains at `127.0.0.1:8787`;
4. the authenticated dashboard shell and API remain healthy;
5. no `WebAssembly is not defined` / Undici crash occurs in the service journal;
6. implementation and event-polling topology remains unchanged.
