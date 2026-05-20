# Postman script compatibility (`pm.*`)

Restura runs your existing Postman test scripts unmodified, with very few
exceptions. Both pre-request scripts and test scripts execute inside a QuickJS
WASM sandbox (see [ADR-0004](./adr/0004-security-hardening.md)) — same security
guarantees as the rest of the renderer.

If a script of yours stops working after import, please file an issue with
the snippet — most gaps are quick to close.

## What works out of the box

### Test reporting

| Postman API | Status |
| --- | --- |
| `pm.test(name, fn)` | ✅ |
| Test results in Tests tab | ✅ |
| Aggregated pass/fail counts | ✅ |

### Assertions (`pm.expect`)

| Pattern | Example | Status |
| --- | --- | --- |
| Strict equality | `pm.expect(x).to.equal(5)` | ✅ |
| Deep equality | `pm.expect(x).to.eql({a:1})`, `pm.expect(x).to.deep.equal(...)` | ✅ |
| Type checks | `pm.expect(x).to.be.a('string')`, `.an('object')`, `.an('array')` | ✅ |
| Boolean predicates | `.be.true`, `.be.false`, `.be.null`, `.be.undefined`, `.be.empty`, `.be.ok` | ✅ |
| Numeric comparisons | `.be.above(n)`, `.be.below(n)`, `.be.within(min,max)`, `.be.closeTo(target,delta)`, `.be.at.least(n)`, `.be.at.most(n)` | ✅ |
| Inclusion | `.include(needle)`, `.contain(needle)`, `.match(regex)` | ✅ |
| Properties | `.have.property('a')`, `.have.property('a', value)` | ✅ |
| Keys / members / length | `.have.keys(['a','b'])`, `.have.members([1,2])`, `.have.length(n)`, `.have.lengthOf(n)` | ✅ |
| Negation | `.not.<anything>` (e.g. `.to.not.have.property('x')`) | ✅ |
| Linking words | `.to`, `.and`, `.that`, `.which` (no-ops for readability) | ✅ |

### Response helpers (`pm.response`)

| Pattern | Status |
| --- | --- |
| `pm.response.to.have.status(code)` | ✅ |
| `pm.response.to.have.header(key)`, `.header(key, value)` | ✅ |
| `pm.response.to.have.body()`, `.body(value)` | ✅ |
| `pm.response.to.have.jsonBody(path, value)` | ✅ |
| `pm.response.to.be.ok` | ✅ |
| `pm.response.to.be.json`, `.html` | ✅ |
| `pm.response.time.below(ms)` | ✅ |
| `pm.response.json()` | ✅ |
| `pm.response.text()` | ✅ |
| `pm.response.code`, `.status`, `.responseTime` (accessor properties) | ✅ |

### Variable namespaces

| Postman API | Status |
| --- | --- |
| `pm.variables.get/set` | ✅ |
| `pm.environment.get/set/unset/has` | ✅ |
| `pm.collectionVariables.get/set/unset/has` | ✅ — shares the workspace namespace with `pm.variables` (v1; collection-scoped split coming) |
| `pm.globals.get/set` | ✅ |
| `pm.iterationData.get(...)` | ⚠️ Returns `undefined`. The data-file iteration runner lands with the contract-testing milestone |

### Request context

| Postman API | Status |
| --- | --- |
| `pm.info.requestName`, `requestId`, `iteration`, `iterationCount` | ✅ |
| `pm.request.url`, `.method`, `.headers`, `.body` (read-only) | ✅ via the top-level `request` global |

### Utilities

| Postman API | Status |
| --- | --- |
| `pm.utils.uuid()`, `randomInt`, `randomFloat`, `randomChoice`, `timestamp`, `isoDate`, `btoa`, `atob`, `hash` | ✅ |
| Postman dynamic variables (`{{$randomInt}}`, `{{$guid}}`, `{{$timestamp}}` etc.) | ✅ — resolved by the environment substitution layer |

### Hoppscotch / pw / hopp aliases

`pw.*` (legacy) and `hopp.*` (v12+) are aliased to the `pm.*` surface for
Hoppscotch users migrating in. Most assertion-style scripts work without
change; some signatures diverge (e.g., `hopp.response.body` vs.
`pm.response.body`) — flag those at import time.

---

## Not yet supported (with workarounds)

| Postman API | Workaround |
| --- | --- |
| `pm.sendRequest(url, callback)` | The QuickJS sandbox is sync-only in v1. Use the workflows feature to chain HTTP requests (`src/features/workflows/`) — strictly more powerful, with retries and variable extraction. The async sandbox upgrade is on the roadmap if a partner team needs callback-style scripting |
| `pm.expect(x).to.have.property('a').and.equal(1)` — subject narrowing on `.and` | Use the two-arg form: `pm.expect(x).to.have.property('a', 1)` |
| `pm.expect(arr).to.include.members([...])` | Use `pm.expect(arr).to.have.members([...])` |
| `pm.execution.skipRequest()` / `setNextRequest()` | Workflow-level conditional steps; rewrite as a `condition` flow node |
| `pm.visualizer.set(...)` | Custom visualizers aren't supported. Use the Monaco preview tab in the response viewer |
| `tv4.validateResult(...)` | Use the Contracts tab (lands in the contract-testing milestone) for OpenAPI/JSON-Schema validation |
| `xml2Json` global | Not bundled. JSON-only test scripts in v1 |

---

## Sandbox limits

The QuickJS WASM sandbox has hard limits that protect the renderer:

- **Memory**: 10MB per script
- **Execution time**: 5 seconds per script
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
