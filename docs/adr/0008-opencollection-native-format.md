# ADR 0008: OpenCollection as the Native Collection Format

**Status:** Accepted, 2026-01-14

## Context

Every API client locks you into its own format. Postman's is locked, Insomnia's is locked, Bruno's is its own dialect. Switching tools means a lossy migration each time, which is a real reason teams stay on tools they've outgrown. Restura needs a canonical on-disk representation for collections that (a) survives round-trips, (b) is vendor-neutral so users can leave, and (c) covers the request-shaped protocols Restura supports — not just HTTP.

We also need the in-memory TypeScript types for that format to stay in lock-step with its schema. Hand-maintaining types alongside a JSON Schema drifts immediately.

## Decision

Adopt **OpenCollection** as Restura's native read/write format, implemented in runtime-neutral `shared/opencollection/`. Two on-disk layouts are supported: a single bundled YAML document and a directory layout through the Node adapters (`node/fs-reader.ts` / `node/fs-writer.ts`).

- The spec's TypeScript types (`spec-types.ts`) are **generated** from the vendored JSON Schema, not hand-written. `npm run gen:opencollection-types` regenerates them and `npm run verify:opencollection-types` is a CI gate that fails the build if the committed types drift from the schema.
- Protocols map as follows: HTTP, GraphQL (an HTTP item with a `graphql` body), gRPC, and WebSocket are first-class OpenCollection items. Socket.IO, SSE, and MCP ride along in `extensions` as `x-restura-socketio` / `x-restura-sse` / `x-restura-mcp`, preserved verbatim across import/export.
- Connection-based protocols (Kafka, MQTT) have no per-request shape, so they are deliberately **not** represented in a collection.
- `to-internal.ts` / `from-internal.ts` convert between the OpenCollection document and Restura's internal request model. An `_oc` bag preserves original OpenCollection fields that the internal model can't represent, so a round-trip is lossless even for features Restura doesn't surface in its UI.

## Consequences

**Positive**

- Users can move in and out of Restura without losing fidelity; the same files drive the desktop app, the web app, and `@restura/cli` ([ADR 0005](./0005-cli-runner.md)).
- The codegen gate guarantees the runtime types never silently diverge from the published schema.
- Vendor extensions give Restura room to represent its own protocols without forking the spec.

**Negative**

- Two layouts (bundled + directory) double the reader/writer surface and its tests.
- The `_oc` preservation bag adds complexity to the converters, but it's the price of lossless round-trips.
- Kafka/MQTT can't be saved to a collection, which can surprise users who expect "everything" to persist.

## References

- User guide: `docs/opencollection.md`, docs-site `/reference/opencollection/`
- Code: `shared/opencollection/` (`spec-types.ts`, `to-internal.ts`, `from-internal.ts`, `node/fs-reader.ts`, `node/fs-writer.ts`, `schemas.ts`)
- Codegen: `npm run gen:opencollection-types`, `npm run verify:opencollection-types`
- Related: [ADR 0005 (CLI runner)](./0005-cli-runner.md), [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md) for secret redaction on export
