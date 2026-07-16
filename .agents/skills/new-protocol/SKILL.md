---
name: new-protocol
description: Scaffold a new Restura protocol across shared core, Worker and self-host, Electron IPC, renderer, capability matrix, tests, and docs.
---

# Add a Restura protocol

Load `restura-feature-dev` and its `references/adding-new-protocol.md`. Confirm
the protocol and choose the closest existing implementation.

Implement in order with a failing test before each behavior: backend-agnostic
`shared/protocol/<name>-proxy.ts`; Worker adapter and `worker/app.ts` route;
self-hosted Node adapter where native behavior differs; Electron handler with
DNS guard, validated/rate-limited/trusted IPC, channel, preload, and API type;
renderer `protocol.ts`, executor, state, and UI; capability source and generated
matrix; security/unit/E2E tests; docs and ADR if warranted. Finish with
`npm run validate`, applicable E2E, `restura-security-auditor`,
`restura-parity-checker`, and `restura-docs-steward`.
