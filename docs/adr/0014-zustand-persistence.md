# ADR 0014: Zustand Persistence Strategy

**Status:** Accepted, 2026-06-02

## Context

All global state (request tabs, collections, environments, history, settings, workflows, Kafka/MQTT connections, AI) lives in Zustand stores. That state must persist across reloads on web and across launches on desktop, and on desktop it must be encrypted at rest. A single persistence story is needed so stores don't each reinvent storage, and so corrupt/old persisted data can't crash the app. This decision sits alongside [ADR 0002](./0002-multi-tab-store.md) (which defined the tab model) and [ADR 0004](./0004-security-hardening.md) (which defined the encryption key provider).

## Decision

Use Zustand's `persist` middleware for every global store, with a platform-selected storage adapter and Zod validation on rehydrate:

- **Web** — `src/lib/shared/dexie-storage.ts` (IndexedDB via Dexie).
- **Desktop** — `src/lib/shared/secure-storage.ts` (encrypted electron-store over IPC; the key is wrapped by Electron `safeStorage` → OS keychain, per [ADR 0004](./0004-security-hardening.md)).
- Persisted blobs are validated against the Zod schemas in `src/lib/shared/store-validators.ts` so malformed or outdated state is rejected rather than silently corrupting the store.

The legacy `localStorage` adapter has been **removed**; new persistence must not go through `window.localStorage`. Secrets within state follow the `SecretRef` handle pattern ([ADR 0007](./0007-secret-ref-pattern.md)) so plaintext never lands in either store.

## Consequences

**Positive**
- One persistence pattern across every store and both platforms; adapters are the only platform-specific piece.
- Schema validation on rehydrate turns "corrupt persisted state" from a crash into a recoverable reset.
- Desktop data is encrypted at rest without each store knowing about keys.

**Negative**
- Two storage backends to test (Dexie vs electron-store), including migration/rehydration edge cases.
- Every persisted store needs a maintained Zod schema, which is extra surface to keep in step with the store shape.

## References
- Code: `src/lib/shared/dexie-storage.ts`, `src/lib/shared/secure-storage.ts`, `src/lib/shared/store-validators.ts`
- Related: [ADR 0002 (multi-tab store)](./0002-multi-tab-store.md), [ADR 0004 (security hardening)](./0004-security-hardening.md), [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md)
