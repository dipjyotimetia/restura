# Build quirks

Aliases and polyfills in `vite.config.mts` that work around third-party
package issues. Each one is load-bearing — please leave the breadcrumbs
intact when touching the build config.

## `ohm-js` → CJS entry alias

```ts
'ohm-js': path.resolve(__dirname, './node_modules/ohm-js/index.js'),
```

**Why.** `@usebruno/lang` (used by the Bruno importer / exporter) does
`const ohm = require('ohm-js'); ohm.grammar(...)`. The `ohm-js` package's
ESM build (`module: dist/ohm.esm.js`) exports `ohm` as the **default**
export — `export { ohm as default, extras }`. Vite's ESM-to-CJS interop
therefore hands `require('ohm-js')` back the shape `{ default, extras }`,
so `ohm.grammar` is `undefined` and the Bruno importer throws
`ohm.grammar is not a function` on every `.bru` file.

The alias pins resolution to `ohm-js/index.js`, the CJS entry. Vite's CJS
plugin then unwraps `module.exports = ohm` correctly and `ohm.grammar()`
is callable.

**Scope.** The alias applies to every Vite bundle (renderer + Cloudflare
Worker). The Worker doesn't currently import `@usebruno/lang`
transitively, so the alias is a no-op there. If that changes, double-check
the Workers runtime tolerates the CJS interop path.

## `buffer` → npm polyfill alias

```ts
buffer: path.resolve(__dirname, './node_modules/buffer/index.js'),
```

**Why.** `swagger-parser` (loaded lazily by the OpenAPI importer)
references the Node `Buffer` global while dereferencing `$ref`s. The
renderer has no native `Buffer`, and Vite (plus `@cloudflare/vite-plugin`)
externalises the bare `buffer` import because it's a Node built-in — the
result at runtime is the cryptic
`Module "buffer" has been externalized for browser compatibility.
Cannot access "buffer.Buffer" in client code.`

The alias force-resolves `import { Buffer } from 'buffer'` to the npm
`buffer` polyfill, which is a real browser-safe class. The importer then
attaches `Buffer` to `globalThis` lazily so the ~12 KB polyfill chunk
doesn't land in the main bundle:

```ts
// src/features/collections/lib/importers/openapi.ts
async function ensureBufferPolyfill() {
  if ('Buffer' in globalThis) return;
  const mod = await import('buffer');
  (globalThis as any).Buffer = mod.Buffer;
}
```

The dynamic import is what keeps the polyfill out of the entry chunk —
only sessions that actually import an OpenAPI spec pay the cost.
