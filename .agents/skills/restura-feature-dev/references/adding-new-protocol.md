# Adding a protocol

1. Define request/response types and an `execute<Name>Proxy` orchestrator under
   `shared/protocol/`. Reuse URL validation, header policy, auth signing, body
   building, timeout, redirect, and response-normalization primitives.
2. Add the Cloudflare fetcher/handler and route it through `worker/app.ts`.
   Confirm `worker/node-entry.ts` supplies any Node-native dependency needed by
   the self-hosted server.
3. Add Electron channel, Zod schema, validated handler, rate limiter,
   trusted-sender check, DNS guard, cleanup ownership, preload method, and
   `ElectronAPI` type.
4. Add renderer `protocol.ts`, executor branching through `isElectron()`, UI,
   and validated persistence when required.
5. Update `src/lib/shared/capabilities.ts` and regenerate the matrix.
6. Add unit, security, parity, and feasible real/E2E tests before documentation.
