---
type: architecture and security
title: Persistence and execution security
description: Offline data ownership, encryption modes, migration lifecycle, secret boundaries, and desktop execution-policy enforcement.
tags: [persistence, security, indexeddb, secrets, electron]
---

# Persistence and execution security

Restura is offline-first. `src/lib/shared/database.ts` defines `ResturaDB`, a Dexie database whose user records use an `encryptedData` field. That field is truly encrypted only when the selected key provider is encrypted; this distinction is deliberate and must remain visible to users and maintainers.

## Data ownership and lifecycle

`ResturaDB` owns collections, environments, history, settings, cookies, OWS workflows, file-collection metadata, request tabs, connection registries, console state, GraphQL schemas, proto files, AI chat/Lab/eval/arena state, globals, and collection-run history. Versioned schema updates reach v14. The internal `metadata` table is excluded from normal export/stat enumeration because it can contain application state and migration quarantine rows.

```mermaid
flowchart TD
    Boot[src main bootstrap] --> Log[registerMigrationLogging]
    Log --> Hydrate[Persisted Zustand stores hydrate]
    Hydrate --> Validate[Validate and migrate records]
    Validate --> Good[Usable store state]
    Validate --> Quarantine[Metadata quarantine and observable log]
    Good --> Export[Encrypted record backup]
    Export --> Import[Merge records by table and key]
```
`src/main.tsx` registers migration logging before asynchronous store hydration; moving it later loses useful migration outcomes. `exportAllData` derives user tables from live Dexie tables, preventing new-table drift; backups contain stored records and importing merges by primary key.

## Key providers

`src/lib/shared/keyProvider.ts` selects the provider:

- Electron uses `ElectronSafeStorageKeyProvider`, persisting the data key through Electron `safeStorage` and OS secure storage.
- Web defaults to `PlaintextKeyProvider`: IndexedDB holds JSON under browser same-origin protection. This replaced unrecoverable ephemeral encryption.
- `WebSessionPassphraseProvider` is available for an explicitly supplied, in-memory session passphrase derived with PBKDF2. Losing that passphrase prevents recovery of encrypted data.

Do not claim that web data is encrypted by default. The recovery/security tradeoff is part of the product boundary.

## Sensitive storage routing

`src/lib/shared/secure-storage.ts` is a narrower Electron bridge for individual sensitive settings. Keys matching `auth`, `token`, `password`, `passphrase`, `apiKey`, `secret`, or `credential` are cached in memory and persisted through the encrypted Electron store, never retained in `localStorage`. On a first synchronous `get` cache miss it can return `null` while it starts asynchronous hydration; consumers that require the value immediately after restart must use `getAsync`. A one-time migration moves a stale plaintext value into the encrypted store and purges local storage. `set` and `remove` both purge plaintext, so a deleted secret cannot be resurrected by a later migration.

## Secrets and execution policy

Protocol secret values can be opaque references. `shared/secrets/external-secret-resolver.ts` creates a fail-closed resolver: it dispatches only to a provider matching the reference, treats missing/empty values as errors, observes cancellation, and maps raw provider failures to stable renderer-safe `ExternalSecretError` codes. Trusted desktop/CLI adapters resolve values; console/export paths redact them.

### External secret profiles

`shared/secrets/external-secret-profile.ts` defines strict, location-only profiles for `aws-secrets-manager`, `google-secret-manager`, and `azure-key-vault`. A profile contains a generated ID, optional label, provider location and an SDK-supported identity locator such as an AWS named profile/workload token file, a Google credential configuration file, or Azure subscription/workload identity metadata. IDs/labels and paths are bounded, provider objects reject unknown fields, and a stored list is capped at 100 profiles. It intentionally contains **no credential values**: those remain in the provider SDK's documented credential source and neither collections nor Electron IPC return them.

Desktop owns profile persistence and resolution wiring. `electron/main/security/external-secret-profile-store.ts` encrypts the profile list in a dedicated `electron-store`, validates loaded rows, updates the request-time main-process profile snapshot after every create/update/delete/clear, and registers validated list/create/update/delete/clear IPC handlers. The renderer receives profile metadata only; `replaceExternalSecretProfiles` is the bridge to main-process request-time resolution. A resolver matches both profile ID and provider, builds only official-SDK clients from that profile, applies a reference selector as AWS version stage, Google version segment, or Azure version, and closes/destroys AWS and Google clients after use.

`materializeExternalProtocolAuth` resolves external values only in trusted main and only for supported secret-bearing fields: Basic password, Bearer/API-key values, OAuth 2 tokens/client secret, AWS secret key, OAuth 1 secrets, NTLM/WSSE passwords. It preserves every non-external form unchanged. Resolution occurs at request time, so a rotated provider value is used on the next request without storing plaintext. Missing/mismatched profiles, unavailable providers, missing/empty values, cancellation, and raw SDK failures become stable redacted `ExternalSecretError` results. Focused proof is in `shared/secrets/__tests__/external-secret-resolver.test.ts` (redaction, rotation, denial and cancellation) and `electron/main/__tests__/external-secret-profile-store.test.ts` (persist/update/delete/reset). Follow this surface when adding a provider: extend the discriminated schema, trusted provider factory/resolver, renderer configuration, IPC validation/types, and redaction/failure tests together. See [Recent history and change rationale](../operations/recent-history-and-change-rationale.md) for why the location-only boundary was added.

Desktop outbound work additionally waits for `electron/main/security/execution-policy.ts`. The renderer hydrates settings and calls its sync initializer; main validates a strict policy snapshot with `ExecutionPolicySchema`, then marks it acknowledged. Validation covers network scope, enabled-proxy type/host consistency, timeout, TLS/cipher choices, CA certificates, and format-specific client certificates: PFX requires `pfx`; PEM requires both certificate and key. `safeDefaultPolicy` permits localhost but not private IPs, enables TLS verification, and has no enabled proxy. `assertExecutionPolicyReady()` fails closed until acknowledgment. `setExecutionPolicy` parses before assignment, so rejected IPC cannot partially modify the snapshot, and `getExecutionPolicy` returns a parsed copy so consumers cannot mutate global policy.

## Change guidance and validation

Adding persisted state means selecting an owner table/store, adding a migration/version when needed, ensuring export/import/stats semantics, validating rehydration, and exposing migration loss/quarantine rather than silently discarding data. Adding a secret provider means update the reference schema, trusted provider wiring, safe errors, and redaction tests. Extending desktop transport settings requires schema validation, sync/acknowledgment, a main-process consumer, and fail-closed tests.

Run focused database/key-provider/store or Electron policy tests, then `npm run type-check:all`. For evidence-bearing changes also run the console and collection-run tests listed in [Console evidence and safety](../features/console-evidence.md).
