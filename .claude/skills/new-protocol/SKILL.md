---
name: new-protocol
description: "Scaffold a new protocol across all Restura harnesses (shared core, Worker, Electron, renderer, CLI) following the established pattern. Use when asked to add support for a new wire protocol (e.g. SignalR, AMQP, NATS)."
argument-hint: '<protocol-name> (e.g. amqp, signalr, redis-pubsub)'
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, Task
effort: high
---

Add a new protocol to Restura: **$ARGUMENTS**.

First invoke the `restura-feature-dev` skill and read its `references/adding-new-protocol.md` — that is the authoritative walkthrough; this command is the execution checklist that drives it. Do NOT restate the skill; follow it.

Before writing code: confirm the protocol category with the user (new protocol = the heavy case touching all layers) and pick an existing protocol with the closest shape (e.g. SSE for streaming-over-HTTP, gRPC for binary RPC, Kafka/MQTT for broker transports) to mirror.

## Build sequence (verify each step compiles before the next)

1. **Shared core** — `shared/protocol/<name>-proxy.ts` exposing `execute<Name>Proxy(spec, fetcher, options)`. Reuse `url-validation.ts` (SSRF), `header-policy.ts`, `body-builder.ts`, `types.ts`. Add a Zod schema if there's a request struct.
2. **Worker adapter** — `worker/handlers/<name>.ts` (Fetcher over `globalThis.fetch`/Sockets), routed in `worker/app.ts`. If it needs Node specifics for self-host, add the adapter in `worker/shared/*-node.ts` / wire in `worker/node-entry.ts`.
3. **Electron adapter** — `electron/main/<name>-handler.ts` (Fetcher over Node `http`/`net`/`tls` via `safe-connect.ts`). Add: IPC channels in a new `electron/shared/channels/<name>.ts` area module (spread into `IPC` / `EVENT_PREFIX` in `electron/shared/channels.ts`, plus a `CHANNEL_PREFIXES` entry for event channels); Zod schema + `createValidatedHandler` in a new area module under `electron/main/ipc/validators/` (exported via its `index.ts`; `electron/main/ipc/ipc-validators.ts` is only the compatibility barrel); rate-limit (`ipc-rate-limiter.ts`); `assertTrustedSender`; pre-flight `dns-guard.ts`; `connection-cleanup.ts` for streaming. Expose in `preload.ts`; type it in a new `electron/types/api/protocols/<name>.ts` (re-exported by the `protocols.ts` barrel) and wire it into `electron/types/electron-api.ts`.
4. **Renderer feature** — `src/features/<name>/` with `protocol.ts`, an executor branching on `isElectron()`, components, and a store (+ Zod validator in `src/lib/shared/store-validators.ts` if persisted).
5. **CLI executor** — `cli/src/runner/executors/<name>.ts` reusing the shared proxy (same wire protocol, auth, `{{var}}` resolution and timeouts as the app), registered in `cli/src/runner/executors/dispatch.ts`, with executor + dispatch tests under `cli/src/runner/executors/__tests__/`. If the CLI can't support it, make dispatch fail explicitly — never silently skip.
6. **Capability** — add a `src/lib/shared/capabilities/<name>.ts` area module and spread it into `CAPABILITIES` in `src/lib/shared/capabilities.ts` (mark desktop-only if it needs raw TCP — no browser sockets). Run `npm run capabilities:matrix`.
7. **Tests** — unit for the shared proxy; security test if it's a new outbound transport (`tests/security/`); an e2e `real-<name>.spec.ts` against the echo server if feasible.
8. **Docs** — dispatch `restura-docs-steward` (new `docs-site/.../protocols/<name>.mdx`, capability matrix, ARCHITECTURE.md, ADR if the transport model is novel). Or run `/docs-sync`.

## Verify

- `npm run type-check:all` (the Electron/Worker handlers are NOT covered by plain `type-check`).
- `npm run capabilities:check`, `npm run lint`, `npm run test:run`, and the CLI workspace tests (`npm test --workspace cli`).
- Dispatch `restura-security-auditor` (new transport = high scrutiny) and `restura-parity-checker` (all layers wired, CLI included).
- Finish with `/ship-check`.
