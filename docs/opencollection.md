# OpenCollection in Restura

Restura speaks the [OpenCollection v1.0.0](https://spec.opencollection.com/) specification natively. Any tool that emits OpenCollection-compliant YAML — most notably **Bruno 3.1 and later** — produces files that Restura can open, edit, and write back without lossy conversion.

The OpenCollection JSON Schema is vendored at `vendor/opencollection/v1.0.0/schema.json` (pinned to a specific upstream commit), and TypeScript types are auto-generated from it. The runtime parser uses Zod schemas and validates every loaded file. See [`src/lib/opencollection/`](../src/lib/opencollection/) for the implementation.

## Layout

A collection on disk is either bundled (single file) or directory (multi-file).

### Bundled — convenient for sharing one file

```yaml
opencollection: '1.0.0'
info:
  name: My API
bundled: true
items:
  - info: { type: http, name: Health }
    http:
      method: GET
      url: https://example.com/health
```

### Directory — recommended for git

```
my-api/
├── opencollection.yml         # collection metadata + config
├── users/
│   ├── _folder.yaml           # folder metadata
│   ├── get-user.yaml          # one request per file (slugified name)
│   └── create-user.yaml
└── posts/
    ├── _folder.yaml
    └── ...
```

Each request file's `info.type` field discriminates the protocol — `http`, `grpc`, `graphql`, `websocket`, `sse`, or `mcp` — so file extensions don't need to vary.

## Restura-specific extensions

OpenCollection v1.0.0 covers HTTP, gRPC, GraphQL, and WebSocket as first-class request types. Restura also supports **Server-Sent Events** and **Model Context Protocol** requests, which v1.0.0 doesn't cover yet. These live under the spec's free-form `extensions` field:

```yaml
extensions:
  x-restura-sse:
    - info: { type: sse, name: User Events }
      sse:
        url: https://example.com/events
        eventFilter: ['user.created', 'user.updated']
  x-restura-mcp:
    - info: { type: mcp, name: Inspector }
      mcp:
        url: http://localhost:3000
        transport: streamable-http
```

These extensions are **roundtrip-stable**: tools that don't understand them ignore them, and Restura re-emits them verbatim on save.

## Authentication

OpenCollection v1.0.0 includes more authentication methods than Restura currently runs at the wire (OAuth1, NTLM, WSSE arrive in Phase 4). Importers and exporters preserve all of them so a Restura-imported file can roundtrip back to Bruno without losing auth configuration:

| OpenCollection auth                                              | Restura runtime support      |
| ---------------------------------------------------------------- | ---------------------------- |
| `none`, `basic`, `bearer`, `apikey`, `digest`, `oauth2`, `awsv4` | ✅ Wired                     |
| `oauth1`, `ntlm`, `wsse`                                         | Round-trips, runs in Phase 4 |

Collection- and folder-level **default auth** round-trips through OC's native `request.auth` (RequestDefaults) at the document root and on folder items — it imports into Restura's collection/folder auth (where nearest-ancestor inheritance applies) and exports back to the same native fields, with no vendor extension.

## Scripts

Request-level pre-request/test scripts round-trip through OC's `runtime.scripts`. Collection- and folder-level scripts — which run against every descendant request on a collection run (collection → folder → request) — round-trip through OC's native `request.scripts` (RequestDefaults) at the document root and on folder items, the same `Script[]` container, with no vendor extension. `before-request` scripts map to Restura's pre-request script and `tests` to the test script; multiple scripts of one type concatenate with a separator comment. Unsupported lifecycle stages (`after-response`, `hooks`) are surfaced via the import-time unrecognized-script counter rather than silently dropped.

## Importing & exporting

- **Import:** Click the import-collection button in the toolbar, choose the **OpenCollection** tab, then drop a bundled YAML file or click to browse.
- **Export:** Right-click a collection in the sidebar → **Export → OpenCollection (YAML)**. The download is a single bundled YAML file.

Directory-layout import/export through a native folder picker lands in **Phase 1** alongside the broader git-workspace work. The unit and filesystem-layer tests in [`src/lib/opencollection/__tests__/`](../src/lib/opencollection/__tests__/) already exercise the directory format end-to-end.

## Stable roundtrip

The importer attaches the original parsed OpenCollection document to the in-memory collection as a non-typed `_oc` passthrough bag, and the directory writer (`saveCollectionToDir`) uses it to emit the cached document verbatim when nothing has been edited.

The bundled-export path used by the **Export → OpenCollection (YAML)** menu always re-serializes through `internalToOC` + the YAML emitter, so its output is _semantically_ identical to the input but may differ in minor stylistic ways (key ordering inside an object, whitespace inside multi-line strings, removal of explicitly-empty arrays). For repo-friendly diffs prefer the directory layout and the Phase 1 directory-export workflow once it ships.

If any item has been modified, both paths fall back to rebuilding from the internal model, which produces clean OpenCollection YAML. Edits, adds, removals, and moves defeat the verbatim shortcut by two complementary mechanisms: the store (`useCollectionStore`) strips the `_oc` bag from a mutated item and every ancestor folder, so a missing bag forces a rebuild of that subtree; and `internalToOC` runs a root-level count reconciliation (`rootStructureUnchanged`) so a **root-level removal** — which strips no ancestor bag and leaves every survivor's bag intact — is still detected and the deleted item never reappears (the root check accounts for SSE/MCP living in `extensions`, not `items`). Collection- and folder-level auth edits count as modifications: the exporter compares the cached document's auth against the live internal auth (in flattened-secret space) and defeats the verbatim shortcut when they differ, so a stale `_oc` bag never re-emits credentials you've since changed. Collection- and folder-level **script** edits are gated the same way — and independently of auth, so editing only a script never recomputes (and thereby drops) an un-modellable auth type that survives solely via the cached `_oc` bytes (see the OAuth1/NTLM/WSSE caveat below). Redacted exports drop the collection-level `_oc` bag and every auth-bearing item bag and rebuild those tiers — a verbatim emit would leak the original (pre-redaction) plaintext. Auth-free item bags survive so GraphQL/WebSocket shapes keep their fidelity.

One caveat on the staleness gate: auth types Restura doesn't run yet (OAuth1, NTLM, WSSE) have no internal representation, so the gate can't see edits to them — in particular, clearing such an auth in-app and then exporting **with secrets included** re-emits the original block from the cached document. Redacted exports are unaffected (that tier always rebuilds). This resolves itself when the types are wired in Phase 4.

## Verifying the schema

The vendored schema can be re-pinned to a newer upstream commit. Re-pin instructions are at [`vendor/opencollection/v1.0.0/SOURCE.md`](../vendor/opencollection/v1.0.0/SOURCE.md). After bumping the schema, run:

```bash
npm run gen:opencollection-types  # regenerate TS types
npm run validate                  # type-check + lint + verify-types + tests
```

The `verify:opencollection-types` step (part of `npm run validate`) ensures the committed `spec-types.ts` matches what the generator produces from the vendored schema — type drift gets caught in CI.

## Related

- Vendored schema: [`vendor/opencollection/v1.0.0/`](../vendor/opencollection/v1.0.0/)
- Implementation: [`src/lib/opencollection/`](../src/lib/opencollection/)
- Phase 0 plan: [`docs/superpowers/plans/2026-05-10-phase-0-opencollection-foundation.md`](./superpowers/plans/2026-05-10-phase-0-opencollection-foundation.md)
- Roadmap: [`docs/superpowers/plans/2026-05-10-restura-roadmap.md`](./superpowers/plans/2026-05-10-restura-roadmap.md)
