# ADR 0008: OpenCollection as the Native Collection Format

**Status:** Accepted, 2026-01-14

## Context

Every API client locks you into its own format. Postman's is locked, Insomnia's is locked, Bruno's is its own dialect. Switching tools means a lossy migration each time, which is a real reason teams stay on tools they've outgrown. Restura needs a canonical on-disk representation for collections that (a) survives round-trips, (b) is vendor-neutral so users can leave, and (c) covers the request-shaped protocols Restura supports — not just HTTP.

We also need the in-memory TypeScript types for that format to stay in lock-step with its schema. Hand-maintaining types alongside a JSON Schema drifts immediately.

## Decision

Adopt **OpenCollection** as Restura's native read/write format, implemented in runtime-neutral `shared/opencollection/`. Two on-disk layouts are supported: a single bundled YAML document and a directory layout through the Node adapters (`node/fs-reader.ts` / `node/fs-writer.ts`).

- The spec's TypeScript types (`spec-types.ts`) are **generated** from the vendored JSON Schema, not hand-written. `npm run gen:opencollection-types` regenerates them and `npm run verify:opencollection-types` is a CI gate that fails the build if the committed types drift from the schema.
- Protocols map as follows: HTTP, GraphQL (an HTTP item with a `graphql` body), gRPC, and WebSocket are first-class OpenCollection items. Socket.IO, SSE, and MCP ride along in `extensions` as `x-restura-socketio` / `x-restura-sse` / `x-restura-mcp`, preserved across import/export (see the amendment below).
- Connection-based protocols (Kafka, MQTT) have no per-request shape, so they are deliberately **not** represented in a collection.
- `to-internal.ts` / `from-internal.ts` convert between the OpenCollection document and Restura's internal request model. An `_oc` bag preserves original OpenCollection fields that the internal model can't represent, so an unedited imported item re-exports verbatim even for features Restura doesn't surface in its UI.

## Amendment (2026-10-12): vendor-extension shape

The original wording above overstated the result: through 2026-10 SSE/MCP fields, foldered SSE/MCP placement, and OAuth1/NTLM/WSSE auth were dropped on round-trip ([#863](https://github.com/dipjyotimetia/restura/issues/863), [#866](https://github.com/dipjyotimetia/restura/issues/866), [#869](https://github.com/dipjyotimetia/restura/issues/869), [#975](https://github.com/dipjyotimetia/restura/issues/975)). The fidelity fixes settle how Restura stores what the schema can't hold:

- **Everything Restura-specific lives in the root `extensions` field, never inline.** The schema's item, folder, `RequestDefaults`, and auth objects are `additionalProperties: false` (and the VS Code extension validates root `opencollection.yml` against it), so no Restura-only key is added to them.
- **Collection-level extensions keyed by node path.** `x-restura-sse` / `x-restura-mcp` entries carry a `folderPath`; `x-restura-grpc` (schema snapshots deduplicated by sha-256 content hash, plus per-request `timeout`) and `x-restura-auth` (OAuth1 `addParamsToBody`, NTLM `workstation`, WSSE `passwordType`, with a `target` of collection/folder/request and the auth `type`) use `path` = folder names + item name, matched in document order.
- **Fidelity is tested, not assumed.** `shared/opencollection/fidelity-roundtrip.test.ts` round-trips a fully-populated fixture per request type whose field policy is exhaustive over the type; fields not yet carried (HTTP `settings`, `contractRef`, the header `secret` marker) are listed there as known gaps and documented in `docs/opencollection.md`.

## Amendment (2026-10-13): `x-restura-http` and partial request settings

The per-request HTTP version preference ([#864](https://github.com/dipjyotimetia/restura/issues/864), desktop-only) has no slot in the schema's `http.settings`, so it is carried in a new collection-level extension, `x-restura-http` (`requests: [{ path, httpVersion }]`, matched by name path like `x-restura-grpc`; `auto` is not emitted). It is the one HTTP setting that now round-trips; the rest of `settings` stays a known gap.

Import applies **only** `httpVersion`. `HttpRequest.settings` became a partial override (`RequestSettingsOverride`) resolved field by field against the workspace defaults, so importing a version preference no longer pins timeout, redirect, and TLS-verification values on the request. Unknown or malformed entries are ignored and the request stays on `auto`.

## Consequences

**Positive**

- Users can move in and out of Restura with a tested round-trip (known gaps are listed in the user guide); the same files drive the desktop app, the web app, and `@restura/cli` ([ADR 0005](./0005-cli-runner.md)).
- The codegen gate guarantees the runtime types never silently diverge from the published schema.
- Vendor extensions give Restura room to represent its own protocols without forking the spec.

**Negative**

- Two layouts (bundled + directory) double the reader/writer surface and its tests.
- The `_oc` preservation bag adds complexity to the converters, but it's the price of byte-stable round-trips.
- Kafka/MQTT can't be saved to a collection, which can surprise users who expect "everything" to persist.

## References

- User guide: `docs/opencollection.md`, docs-site `/reference/opencollection/`
- Code: `shared/opencollection/` (`spec-types.ts`, `to-internal.ts`, `from-internal.ts`, `node/fs-reader.ts`, `node/fs-writer.ts`, `schemas.ts`)
- Codegen: `npm run gen:opencollection-types`, `npm run verify:opencollection-types`
- Related: [ADR 0005 (CLI runner)](./0005-cli-runner.md), [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md) for secret redaction on export
