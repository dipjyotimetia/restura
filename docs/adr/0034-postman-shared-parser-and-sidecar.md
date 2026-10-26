# ADR 0034: Shared Postman Parser and `_postman` Sidecar

**Status:** Accepted, 2026-10-26

## Context

Postman v2.x import lived in the renderer (`src/features/collections/lib/importers/postman.ts`) on top of the `postman-collection` SDK. That had three problems:

- **No CLI path.** The CLI and other runtime-neutral code cannot import renderer `src/`, so a second importer would have been needed for `restura` CLI import (#1202).
- **Silent loss.** Unsupported auth (hawk, edgegrid, jwt, akamai, and OAuth1 / NTLM, which Restura does support) became `none` with no warning. Saved responses, `protocolProfileBehavior`, item variables, extra same-kind events, file-body paths and OAuth2 implicit / PKCE details were dropped without a trace.
- **No room for v3.** Postman Collection v3 ([epic #1197](https://github.com/dipjyotimetia/restura/issues/1197)) is a multi-file YAML folder whose objects are all `additionalProperties: false`. The SDK cannot read it, and v3 must reach the same internal model as v2.1.

## Decision

1. **One SDK-free parser in `shared/collections/postman/`.** It runs anywhere (no DOM, no `src/` imports) and is used by the renderer importer (now a thin adapter) and later by the CLI. Version front ends (`parse-v2.ts` for v2.0 / v2.1, a v3 front end in #1200) feed one normalised path. They share the auth mapping (`auth.ts`: parameter blocks are normalised to a flat key/value map first), the report (`report.ts`) and the sidecar (`sidecar.ts`). `importPostmanCollection(data, { transformScript }) → { collection, report }`. The `pm.*` → `rs.*` script migration is injected by the caller, because its implementation lives in the renderer today.
2. **No silent loss.** Every construct that is dropped or approximated produces a structured report entry (the shapes are a subset of the renderer's `ImportWarning`, so the UI and CLI print them unchanged). Its raw Postman JSON is also kept in a `_postman` sidecar on the collection, folder or request item it came from. OAuth1 and NTLM now map 1:1. Unsupported auth becomes `none` with a warning and the raw block in the sidecar. OAuth2 implicit / PKCE and OAuth1 RSA, body/URL placement and unsupported signature methods map approximately, with a warning and the raw block in the sidecar.
3. **The sidecar lives in Restura only, and behaves like OpenCollection's `_oc`.** The import gate keeps the original object, so `_postman` survives validation. `useCollectionStore` strips `_oc` and `_postman` together along the mutation path (one helper), so a bag never describes a request the user has since edited. `shared/secrets/collection-redaction.ts` sanitises and counts `_postman` bags wherever `_oc` bags are handled, because they can carry credentials: hawk keys, edgegrid tokens, jwt secrets, OAuth secrets, and saved-response headers, cookies and bodies. For approximated typed auth (OAuth1 / OAuth2) the sidecar keeps only the keys the typed model lacks (`privateKey`, `signatureMethod`, `grant_type`, `refreshToken`, …), never a second copy of mapped credentials (ADR-0007). When the user chooses "store secrets as handles", `convertCollectionSecretsToHandles` also turns bag-only auth credentials into keychain handles and blanks every other secret-bearing sidecar value, failing closed if the keychain rejects. Every path that strips or duplicates bags uses one list, `PASSTHROUGH_BAG_KEYS` (`shared/collections/passthrough-bags.ts`), and the root `_postman` is dropped when collection auth, variables or scripts are edited. Import rejects folder nesting deeper than 64 levels. Report entries carry only names and fixed notes, and sidecar contents are never logged. The sidecar is **never written into v3 files** (the v3 schema forbids extra properties).
4. **Formats.** v2.1 (single JSON file) stays the default export. v3 on disk is a YAML folder. Import accepts a folder, a zip or a single JSON/YAML file. Export writes a folder on Electron and a zip on the web.
5. **MCP stdio items from a v3 import arrive disabled** and flagged, and are never auto-run (CLI included), because an imported file must not be able to launch a local process.
6. **The importer no longer uses the `postman-collection` SDK, but the runtime dependency stays.** `@types/postman-collection` is removed. The `postman-collection` package itself is kept on purpose: the script sandbox bundles it (`scripts/build-sandbox-libs.mjs`) so user scripts can call `require('postman-collection')`, which is documented Postman compatibility (`docs/postman-compat.md`). Removing it would break that. The dependency now exists only for the sandbox, not for import.

### Alternatives considered

- **Keep the SDK for v2.1 and write a v3 parser beside it.** Rejected. It means two internal paths, the SDK still cannot run outside the renderer bundle cheaply, and the silent drops would remain.
- **Drop unmodelled constructs with only a warning.** Rejected. Re-export and future features (saved responses, examples) would have nothing to work from.
- **Embed the sidecar in exported files.** Rejected. v3 is `additionalProperties: false`, and an embedded bag would re-emit stale or secret data.

## Consequences

- One place to fix Postman parsing for the renderer and the CLI. v3 adds a front end, not a second importer.
- Users see what was lost or approximated at import time.
- Each new sidecar field must be added to the redactor's walk (`redactPostmanBag` / `countPostmanBagInlineSecrets`), and each newly mapped auth key to `POSTMAN_MAPPED_AUTH_PARAMS` (`shared/collections/postman/auth.ts`), or secrets are duplicated, double-counted or missed.
- The root `_oc` is still not stripped by `updateCollection`: `internalToOC` re-checks root auth and scripts against the live model before it uses the cached root.

## References

- Code: `shared/collections/postman/`, `src/features/collections/lib/importers/postman.ts`, `src/store/useCollectionStore.ts` (`stripPassthroughBags`), `shared/secrets/collection-redaction.ts`, `tests/security/postman-sidecar-secret-leak.test.ts`
- Issues: #1197 (epic), #1199, #1200, #1201, #1202
- Related: [ADR 0007 (SecretRef pattern)](./0007-secret-ref-pattern.md)
