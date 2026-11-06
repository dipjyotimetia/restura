# Postman script compatibility (`pm.*`)

Collection import/export (Postman v2.x and v3) is covered in the docs-site guide *Import & export* and ADR 0034; this page is about scripts only.

On desktop, **File → Export Collection…** (CmdOrCtrl+E) exports the active collection (the one owning the active tab's saved request, else the only collection) as Postman v3. Export menu: **Postman v3 (folder / zip)** is first, the default and recommended. **Postman v2.1 (single file · Newman)** is second. Newman cannot run v3 collections, so pick v2.1 for Newman or CI on v2.1 tooling; the Restura CLI runs both. The v2.1 export restores the `_postman` sidecar (saved responses/examples, `protocolProfileBehavior`, extra events, unsupported auth) and exports basic/bearer/apikey/oauth1/oauth2/digest/awsv4/ntlm auth; inline auth secrets follow the include-secrets prompt (excluded means blanked), while secret variables and keychain/external handles are always exported empty. gRPC, SSE, MCP, Kafka, MQTT and WebSocket/Socket.IO placeholder folders are listed in the export report, not exported; GraphQL subscriptions are HTTP requests and are exported, with only the subscription setting dropped (`graphql-extras`). Imported explicit `noauth`, and any request under an unsupported-auth folder, is refused at send ("Not sent") on web, desktop and the CLI instead of inheriting a parent's credential; an `explicit-noauth` report entry makes `--strict-import` exit 2, and export writes an explicit `noauth`. When secrets are excluded on export, credential-named urlencoded/form-data text rows and nested OAuth2 values (`client_assertion`, `code_verifier`, `assertion`) are blanked in every exporter, keychain handles in sidecar auth are written empty and reported, and the export report flags restored hidden scripts (`restored-events`) and local file paths (`restored-file-path`). v2.1 import takes `type: "secret"` variables value-less with a warning. v2.x import applies a request's `protocolProfileBehavior` as Restura request settings (as v3 `settings` already were) and keeps only the unmapped keys in the sidecar; it keeps request and folder descriptions, never runs a disabled event, keeps form-data part content types, keeps GraphQL variables as text (so `{{var}}` templates survive), and reports an awsv4 `sessionToken` as `awsv4-options` (the signer does not send it; export restores it). Unsupported auth (hawk, jwt, edgegrid, asap, azure, sasl, akamai) imports as no auth with an `unsupported-auth` warning; the raw auth is kept in the `_postman` sidecar and Postman v3 export restores it; v2.1 export restores only hawk and edgegrid, and writes jwt/asap/akamai/azure/sasl as `noauth` and reports them.

Environment files (Postman `*.postman_environment.json`, Hoppscotch environments, and Bruno `environments/*.bru` inside a Bruno import): on desktop, secret variables keep their values like a hand-typed secret; in the browser (web and self-host) their values are dropped and the import warnings list the keys to re-enter.

Restura runs your existing Postman test scripts unmodified, with very few
exceptions. Both pre-request scripts and test scripts execute inside a QuickJS
WASM sandbox (see [ADR-0004](./adr/0004-security-hardening.md)) — same security
guarantees as the rest of the renderer.

If a script of yours stops working after import, please file an issue with
the snippet — most gaps are quick to close.

## What works out of the box

### Test reporting

| Postman API                 | Status |
| --------------------------- | ------ |
| `pm.test(name, fn)`         | ✅ — `fn` may be `async` or return a promise; a rejection fails the test, and one still pending when the script ends fails as well |
| Test results in Tests tab   | ✅     |
| Aggregated pass/fail counts | ✅     |

### Assertions (`pm.expect`)

| Pattern                 | Example                                                                                                                 | Status |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| Strict equality         | `pm.expect(x).to.equal(5)`                                                                                              | ✅     |
| Deep equality           | `pm.expect(x).to.eql({a:1})`, `pm.expect(x).to.deep.equal(...)`                                                         | ✅     |
| Type checks             | `pm.expect(x).to.be.a('string')`, `.an('object')`, `.an('array')`                                                       | ✅     |
| Boolean predicates      | `.be.true`, `.be.false`, `.be.null`, `.be.undefined`, `.be.empty`, `.be.ok`                                             | ✅     |
| Numeric comparisons     | `.be.above(n)`, `.be.below(n)`, `.be.within(min,max)`, `.be.closeTo(target,delta)`, `.be.at.least(n)`, `.be.at.most(n)` | ✅     |
| Inclusion               | `.include(needle)`, `.contain(needle)`, `.match(regex)`                                                                 | ✅     |
| Properties              | `.have.property('a')`, `.have.property('a', value)`                                                                     | ✅     |
| Keys / members / length | `.have.keys(['a','b'])`, `.have.members([1,2])`, `.have.length(n)`, `.have.lengthOf(n)`                                 | ✅     |
| Negation                | `.not.<anything>` (e.g. `.to.not.have.property('x')`)                                                                   | ✅     |
| Linking words           | `.to`, `.and`, `.that`, `.which` (no-ops for readability)                                                               | ✅     |

`pm.expect` is the real bundled `chai.expect`, so chains not listed above (for example `.include.members([...])` or subject narrowing on `.and`) behave as they do in Postman.

### Response helpers (`pm.response`)

| Pattern                                                              | Status |
| -------------------------------------------------------------------- | ------ |
| `pm.response.to.have.status(code)`, `.status('OK')` (status text)    | ✅     |
| `pm.response.to.have.header(key)`, `.header(key, value)`             | ✅     |
| `pm.response.to.have.body()`, `.body(text \| RegExp \| object)`      | ✅     |
| `pm.response.to.have.jsonBody()`, `.jsonBody(path)`, `.jsonBody(path, value)` | ✅ ² |
| `pm.response.to.be.ok`, `.success`, `.info`, `.redirection`, `.clientError`, `.serverError`, `.error`, `.accepted`, `.badRequest`, `.unauthorized`, `.forbidden`, `.notFound`, `.rateLimited`, `.withBody` | ✅ ³ |
| `pm.response.to.be.json`, `.html`                                    | ✅ ³   |
| `pm.response.to.not.*` (negates any of the above)                    | ✅     |
| `pm.response.time.below(ms)`                                         | ✅     |
| `pm.response.json()`                                                 | ✅     |
| `pm.response.text()`                                                 | ✅     |
| `pm.response.code`, `.status`, `.responseTime` (accessor properties) | ✅     |
| `pm.response.headers.get/has/all/each/toObject`                      | ✅ ¹   |
| `pm.response.cookies.get/has/all/toJSON/each/toObject`               | ✅     |
| `pm.response.statusDetails` (gRPC rich error details; Restura extension) | ✅  |

² The body is parsed from the response text, the same on web, desktop and the CLI. With a path, the assertion fails when the path is missing.

³ Property assertions assert when read, as in Postman (`pm.response.to.be.ok;`). The call form (`pm.response.to.be.ok()`) works too. `ok` passes any 2xx status.

Test scripts get the response body as text everywhere (`response.body`, `pm.response.text()`); `pm.response.json()` parses it. `pm.response.code` is the numeric status, `pm.response.status` the status text (the CLI uses the standard reason phrase), and `pm.response.responseTime` a number in milliseconds. `pm.response.time` is not a number: it only carries `.below(ms)`.

¹ A response can carry several `Set-Cookie` headers. `pm.response.headers.get('Set-Cookie')` returns all of them joined with `", "` (Postman returns only the last). `all()` / `each()` give one row per cookie, and `has('Set-Cookie', v)` and `pm.response.to.have.header('Set-Cookie', v)` match any single cookie. The raw list is `response.setCookies` (`string[]`) and the parsed one `response.cookies`. Both behave the same on web, desktop and the CLI, and `pm.sendRequest` responses carry them too. `pm.response.cookies` covers only the cookies this response set; `pm.cookies` is the jar.

### Variable namespaces

| Postman API                                | Status                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `pm.variables.get/set`                     | ✅ — local: the rest of this request (and of a collection run); never saved                     |
| `pm.environment.get/set/unset/has`         | ✅ — writes from pre-request and test scripts are saved to the active environment (on single Send, and in a collection run to the run's environment) ⁴ |
| `pm.collectionVariables.get/set/unset/has` | ✅ — reads/writes the request's owning collection and persists mutations back to it              |
| `pm.globals.get/set`                       | ✅                                                                                               |
| `pm.iterationData.get/set/has/toObject`    | ✅ — reflects the current CSV/JSON row during a data-driven collection run (empty on single send) |

⁴ A variable stored as a desktop secret handle is never overwritten or removed by a script (the app says which keys it skipped). A script from a collection writes without asking only to an environment scoped to that collection (or when the request is not in any collection). Writes from a collection's script to a shared (global) environment are held and Restura asks once per collection and environment: **Save** stores them and later writes from that collection, **Don't save** keeps them for that request or run only — so an imported collection cannot silently redirect your other requests (and the secrets they send). With no environment selected, writes last only for the request or run. The CLI has no environment file to write back: `pm.environment` writes carry through the run only.

A script that throws keeps the variable writes it made before the error, and the request is still sent with them.

### Request context

| Postman API                                                       | Status                                |
| ----------------------------------------------------------------- | ------------------------------------- |
| `pm.info.requestName`, `requestId`, `iteration`, `iterationCount`, `eventName` | ✅                                    |
| `pm.execution.location` (`collectionName`, `currentRequestName`, `folderPath`) | ✅ populated during collection runs   |
| `pm.request.url`, `.method`, `.body` (read-only)                              | ✅ via the top-level `request` global |
| `pm.request.headers.add/upsert/remove/get/has/all/each/toObject`              | ✅ — edits in a pre-request script are sent for HTTP and GraphQL on web, desktop and the CLI (gRPC: the same methods edit the metadata; MCP ignores header edits). Names are case-insensitive and hold one value each, so `add` of an existing name replaces it. As with gRPC metadata, a script cannot add a secret-variable token to a header (the send is refused) |
| `pm.request.metadata` (gRPC)                                                   | ✅ editable in pre-request scripts; `pm.request.headers` is the same object and edits are sent with the call |
| `pm.response.metadata`, `pm.response.trailers` (gRPC)                          | ✅ `get/has/all/each/toObject`; raw maps on `response.headers` / `response.trailers` |
| `pm.response.messages` (gRPC streams)                                          | ✅ `all/count/idx/each`; test scripts run once the stream ends              |

### Network, flow control, and libraries

| Postman API                                     | Status                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pm.sendRequest(input, cb?)`                    | ✅ — routed through the same SSRF-guarded proxy as a normal send; returns a promise. Works from interactive Send, gRPC, and collection runs        |
| `pm.cookies` (incl. async `.jar()`)             | ✅                                                                                                                                                |
| `pm.execution.setNextRequest` / `skipRequest`   | ✅ — collection-runner flow control; `skipRequest()` sends nothing and skips the test script in the CLI runner and in the app's Collection run. Under stop-on-failure / `--bail`, an unknown `setNextRequest` name or the jump cap stops the run |
| `pm.visualizer.set(template, data)`             | ✅ — rendered in a sandboxed iframe tab                                                                                                            |
| `pm.vault`                                      | ✅ desktop only (`await pm.vault.get(...)`)                                                                                                        |
| `require(name)`                                 | ✅ bundled set: `ajv`, `chai`, `cheerio`, `crypto-js`, `csv-parse/sync`, `lodash`, `moment`, `postman-collection`, `tv4`, `uuid`, `xml2js`          |
| Legacy `postman.*` and `tests["label"] = bool`  | ✅ — aliases for `pm.environment.*`, `pm.globals.*`, `pm.execution.setNextRequest`, and `pm.test`                                                   |

### Utilities

| Postman API                                                                                                   | Status                                              |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `pm.utils.uuid()`, `randomInt`, `randomFloat`, `randomChoice`, `timestamp`, `isoDate`, `btoa`, `atob`, `hash` | ✅                                                  |
| Postman dynamic variables (`{{$randomInt}}`, `{{$guid}}`, `{{$timestamp}}` etc.)                              | ✅ — resolved by the environment substitution layer |

### Hoppscotch / pw / hopp aliases

`pw.*` (legacy) and `hopp.*` (v12+) are aliased to the `pm.*` surface for
Hoppscotch users migrating in. Most assertion-style scripts work without
change; some signatures diverge (e.g., `hopp.response.body` vs.
`pm.response.body`) — flag those at import time.

---

## Not supported

| Postman API                     | Workaround                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `xml2Json` global               | Use `require('xml2js')` from the bundled library set                                           |
| Raw `fetch` / `XMLHttpRequest`  | Use `pm.sendRequest(...)`, which goes through the SSRF-guarded proxy                           |
| Arbitrary `require('...')`      | Only the bundled library set above is available — no npm or Node core modules                 |

The CLI runs the same sandbox, but `pm.sendRequest`, `pm.cookies`, and `pm.vault` are not wired there (no cookie jar or OS keychain in a CI process) and reject with a clear error.

---

## Sandbox limits

The QuickJS WASM sandbox has hard limits that protect the renderer:

- **Memory**: 64 MB per script runtime
- **Execution time**: 5 seconds for synchronous scripts; 30 seconds when a host bridge (`pm.sendRequest`, `pm.vault`, cookies) is in use
- **No DOM**, no `fetch`, no filesystem, no `process`, no `require`
- **No `eval` escape**: `Function`, `eval`, `__proto__` walk, `constructor[]` lookups all stay inside the sandbox boundary

If a script hits a limit, the offending pre-request/test pass reports an
error in the script result panel; the request itself still executes (a
failed pre-request doesn't cancel the call).

---

## Reporting gaps

If you find a Postman script idiom that doesn't run as-is, please:

1. Open an issue with the smallest reproducing snippet
2. Tag it `postman-compat`
3. Note which version of Postman the script came from (the runtime semantics
   have changed materially between v9 and v11)

The shim is covered by `src/features/scripts/lib/__tests__/pmShim.test.ts` —
new compatibility issues become test cases there before the fix lands.
