# OpenCollection in Restura

Restura speaks the [OpenCollection v1.0.0](https://spec.opencollection.com/) specification natively. Any tool that emits OpenCollection-compliant YAML — most notably **Bruno 3.1 and later** — produces files that Restura can open, edit, and write back without lossy conversion.

The OpenCollection JSON Schema is vendored at `vendor/opencollection/v1.0.0/schema.json` (pinned to a specific upstream commit), and TypeScript types are auto-generated from it. The runtime parser uses Zod schemas and validates every loaded file. See [`shared/opencollection/`](../shared/opencollection/) for the implementation.

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

OpenCollection v1.0.0 covers HTTP, gRPC, GraphQL, and WebSocket as first-class request types. Restura also supports **Server-Sent Events** and **Model Context Protocol** requests, which v1.0.0 doesn't cover yet, and some request/auth data the schema has no slot for (its item and auth objects are `additionalProperties: false`, and the VS Code extension validates root `opencollection.yml` against that schema). All of it lives under the spec's free-form root `extensions` field:

```yaml
extensions:
  x-restura-sse:
    - info: { type: sse, name: User Events }
      sse:
        url: https://example.com/events
        eventFilter: ['user.created', 'user.updated']
      folderPath: [Streams] # ancestor folder names; omitted at the root
  x-restura-mcp:
    - info: { type: mcp, name: Echo tool }
      mcp:
        url: http://localhost:3000
        transport: streamable-http
        defaultMethod: tools/call # the one saved operation
        defaultParams: '{"name":"echo","arguments":{"text":"hi"}}'
  x-restura-grpc:
    schemas:
      <sha-256 hex>: { kind: proto, fileName: greet.proto, text: '...' }
    requests:
      - path: [Folder, Say hello] # folder names + request name
        schema: <sha-256 hex>
        schemaFetchedAt: 1760000000000 # when the snapshot was captured
        timeout: 5000
  x-restura-graphql:
    schemas:
      <sha-256 hex>: { sdl: 'type Query { ... }' }
    requests:
      - path: [Folder, Get viewer]
        schema: <sha-256 hex>
        source: sdl
        fileName: api.graphqls
        importedAt: 1700000000000
        operationName: GetViewer # selected operation (multi-operation documents)
      - path: [Live ticks]
        subscriptionProtocol: graphql-sse # auto | graphql-transport-ws | subscriptions-transport-ws | graphql-sse
  x-restura-auth:
    entries:
      - target: collection # collection | folder | request
        path: []
        type: ntlm
        workstation: WS01
      - target: request
        path: [Folder, Create user]
        type: oauth1
        addParamsToBody: true
  x-restura-http:
    requests:
      - path: [Folder, Stream over h2c] # folder names + request name
        httpVersion: h2c-prior-knowledge # http1.1 | http2 | h2c-prior-knowledge
```

- **`x-restura-kafka` / `x-restura-mqtt`** — Kafka and MQTT connection presets (desktop, [#984](https://github.com/dipjyotimetia/restura/issues/984)): `connection` plus the operation drafts (Kafka `produce` / `consume`; MQTT `publish`, `subscribe` and saved publish `templates`), placed with a `folderPath` like SSE/MCP. Passwords, OAuth tokens and key passphrases are never written — they stay in the desktop's encrypted store. `{{var}}` references are kept as typed and resolved at send time. The CLI skips these entries with a notice.
- **`x-restura-sse` / `x-restura-mcp`** — SSE and MCP requests with all their fields. `folderPath` places the item back in its folder on import; entries without one (or whose folder no longer exists) load at the collection root. A saved MCP request is one operation: `defaultMethod` (`tools/call`, `resources/read`, `prompts/get`, …) plus JSON `defaultParams`. The CLI fails an MCP item that has no `defaultMethod` rather than sending a `ping`.
- **`x-restura-grpc`** — gRPC schema snapshots (reflected or uploaded `FileDescriptorProto`s as base64 `descriptors` — uploads carry a `fileName` label — or an uploaded `.proto`) deduplicated by content hash, plus per-request `timeout` and `schemaFetchedAt` (snapshot capture time; the snapshot's hash is the table key). Import re-inlines them onto the requests so a saved gRPC request runs without re-reflecting.
- **`x-restura-graphql`** — GraphQL schemas the user loaded by hand (SDL or introspection JSON, stored as SDL), deduplicated by a hash of the SDL alone; provenance (`source`, `fileName`, `importedAt`) stays on each request entry. Import re-inlines them onto the requests so completion and validation work without introspection. An entry may also carry `subscriptionProtocol` (the request's subscription wire protocol; `auto` when absent, and an unknown value degrades to `auto`) and `operationName` (the operation selected in a multi-operation document, sent as `operationName` by the app — over HTTP and every subscription protocol — and by the CLI). Schema, protocol and operation are independent: an entry carries any combination of them.
- **`x-restura-auth`** — auth options the schema's auth objects lack: OAuth 1.0a `addParamsToBody`, NTLM `workstation`, WSSE `passwordType`. An entry only applies to a node whose imported auth has the entry's `type`.
- **`x-restura-http`** — per-request HTTP settings the schema's `http.settings` object can't hold. Today that is only the desktop HTTP version preference (`httpVersion`); `auto` is the default and isn't written. Import sets only `httpVersion` and ignores unknown values. A request's other settings (timeout, redirects, TLS verification) keep following your workspace defaults, because Restura stores request settings as a partial override.

Request entries in `x-restura-grpc` / `x-restura-graphql` / `x-restura-auth` / `x-restura-http` are matched by name path in document order, so duplicate names resolve positionally. A `x-restura-graphql` entry also carries `index` (its position among the HTTP requests sharing that path) whenever an earlier same-path request exists, so a REST request with the same name can't claim a GraphQL request's schema. Tools that don't understand these extensions ignore them; Restura rebuilds them from the collection on every export and keeps any other `x-*` key from an imported file.

## Authentication

| OpenCollection auth                                                         | Import mapping            | Applied on send                                              |
| --------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| `none`, `basic`, `bearer`, `apikey`, `oauth2`, `awsv4`                      | ✅ Mapped to Restura auth | ✅                                                            |
| `oauth1`, `wsse`                                                            | ✅ Mapped to Restura auth | ✅ Signed at the wire (HTTP)                                  |
| `digest`                                                                    | ✅ Mapped to Restura auth | ✅ Answered after the 401 challenge (HTTP)                     |
| `ntlm`                                                                      | ✅ Mapped to Restura auth | ❌ Not yet ([#1069](https://github.com/dipjyotimetia/restura/issues/1069)) |

OAuth 1.0a signature methods Restura can't sign with (`RSA-*`, `HMAC-SHA512`) import as the signer default; the original block survives verbatim only while the imported item is unedited. Auth types the mapper doesn't know import as `none` and likewise survive only via the cached document.

Collection- and folder-level **default auth** round-trips through OC's native `request.auth` (RequestDefaults) at the document root and on folder items — it imports into Restura's collection/folder auth (where nearest-ancestor inheritance applies) and exports back to the same native fields, with no vendor extension.

## Scripts

Request-level pre-request/test scripts round-trip through OC's `runtime.scripts`. Collection- and folder-level scripts — which run against every descendant request on a collection run (collection → folder → request) — round-trip through OC's native `request.scripts` (RequestDefaults) at the document root and on folder items, the same `Script[]` container, with no vendor extension. `before-request` scripts map to Restura's pre-request script and `tests` to the test script; multiple scripts of one type concatenate with a separator comment. Unsupported lifecycle stages (`after-response`, `hooks`) are surfaced via the import-time unrecognized-script counter rather than silently dropped.

## Importing & exporting

- **Import:** Click the import-collection button in the toolbar, choose the **OpenCollection** tab, then drop a bundled YAML file or click to browse.
- **Export:** Right-click a collection in the sidebar → **Export → OpenCollection (YAML)**. The download is a single bundled YAML file.

HTTP methods round-trip as written: standard methods upper-cased, extension methods (`PROPFIND`, `QUERY`, …) verbatim, case included. On import, a method that isn't a valid RFC 9110 token, or is denied (`CONNECT`, `TRACE`, `TRACK`), becomes `GET` and Restura shows a warning naming the request. The rest of the collection still loads.

On desktop, **Open Collection from Folder**, **Save to Files**, and **Clone OpenCollection workspace** use the directory layout directly. A file-backed collection’s **Git…** dialog includes status, staging, commits, branches, remote sync, and explicit branch merges.

### HAR browser captures

The collection import dialog also accepts **HAR 1.2 JSON** from a file or paste. Restura parses it as untrusted input with a 16 MiB source limit, 10,000-entry limit, 32-level nesting limit, and bounded headers and bodies; compressed archives are not accepted. It groups requests by HAR page (or origin when a page is absent), redacts credentials before the preview is rendered, and requires explicit entry selection before it writes a collection.

Imported requests retain the HTTP method (extension methods keep their case), URL/query, headers, request MIME/body, form metadata, and representable page/timing provenance. Cookies, response bodies, and unrepresentable binary payloads are discarded or downgraded with a visible warning; captured traffic never executes during import. Provenance is preserved in the round-trippable `extensions.x-restura-har` bag until the collection is structurally edited.

During a conflicted merge, Restura validates root, folder, and request YAML against the same OpenCollection schemas used at load time. Mapping values receive field-level base/local/incoming choices; arrays are deliberately atomic. The resulting document is editable and is validated again before it reaches Git’s index. Invalid OpenCollection content cannot be staged or committed through the merge flow.

## Stable roundtrip

The importer attaches the original parsed OpenCollection document to the in-memory collection as a non-typed `_oc` passthrough bag, and the directory writer (`saveCollectionToDir`) uses it to emit the cached document verbatim when nothing has been edited.

The bundled-export path used by the **Export → OpenCollection (YAML)** menu always re-serializes through `internalToOC` + the YAML emitter, so its output is _semantically_ identical to the input but may differ in minor stylistic ways (key ordering inside an object, whitespace inside multi-line strings, removal of explicitly-empty arrays). For repo-friendly diffs prefer the desktop directory layout.

If any item has been modified, both paths fall back to rebuilding from the internal model, which produces clean OpenCollection YAML. Edits, adds, removals, and moves defeat the verbatim shortcut by two complementary mechanisms: the store (`useCollectionStore`) strips the `_oc` bag from a mutated item and every ancestor folder, so a missing bag forces a rebuild of that subtree; and `internalToOC` runs a root-level count reconciliation (`rootStructureUnchanged`) so a **root-level removal** — which strips no ancestor bag and leaves every survivor's bag intact — is still detected and the deleted item never reappears (the root check accounts for SSE/MCP living in `extensions`, not `items`). Collection- and folder-level auth edits count as modifications: the exporter compares the cached document's auth against the live internal auth (in flattened-secret space) and defeats the verbatim shortcut when they differ, so a stale `_oc` bag never re-emits credentials you've since changed. Collection- and folder-level **script** edits are gated the same way — and independently of auth, so editing only a script never recomputes (and thereby drops) an un-modellable auth type that survives solely via the cached `_oc` bytes (see the caveat below). Redacted exports drop the collection-level `_oc` bag and every auth-bearing item bag and rebuild those tiers — a verbatim emit would leak the original (pre-redaction) plaintext. Auth-free item bags survive so GraphQL/WebSocket shapes keep their fidelity, with credential-named or `secret`-flagged header / param / metadata rows blanked (so e.g. an MCP `Authorization` header in a cached `x-restura-mcp` entry never re-emits).

One caveat on the staleness gate: auth the OpenCollection mapper doesn't model (unknown auth types) imports as `none`, so the gate can't see edits to it — in particular, clearing such an auth in-app and then exporting **with secrets included** re-emits the original block from the cached document. Redacted exports are unaffected (that tier always rebuilds). OAuth1, NTLM, and WSSE are modelled and not affected. The `x-restura-auth` options are compared separately from the auth block, so editing only one of them (for example an NTLM workstation) still defeats the verbatim shortcut.

## Verifying the schema

The vendored schema can be re-pinned to a newer upstream commit. Re-pin instructions are at [`vendor/opencollection/v1.0.0/SOURCE.md`](../vendor/opencollection/v1.0.0/SOURCE.md). After bumping the schema, run:

```bash
npm run gen:opencollection-types  # regenerate TS types
npm run validate                  # static policy + tests/coverage + all production builds/size
```

The `verify:opencollection-types` step (part of `npm run validate`) ensures the committed `spec-types.ts` matches what the generator produces from the vendored schema — type drift gets caught in CI.

## Related

- Vendored schema: [`vendor/opencollection/v1.0.0/`](../vendor/opencollection/v1.0.0/)
- Implementation: [`shared/opencollection/`](../shared/opencollection/)
- Phase 0 plan: [`docs/superpowers/plans/2026-05-10-phase-0-opencollection-foundation.md`](./superpowers/plans/2026-05-10-phase-0-opencollection-foundation.md)
- Roadmap: [`docs/superpowers/plans/2026-05-10-restura-roadmap.md`](./superpowers/plans/2026-05-10-restura-roadmap.md)
