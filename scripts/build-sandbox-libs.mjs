#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Build script that bundles the Postman-compatible library set into
 * stringified IIFE sources, then writes them as a single ESM module
 * (`bundle.generated.ts`) that the renderer can lazy-import.
 *
 * Each library is bundled with esbuild as an IIFE that attaches its
 * exports to `globalThis.__sandboxLib_<name>`. At runtime, the QuickJS
 * sandbox eval's all of these sources, then a `require(name)` shim
 * returns the corresponding global.
 *
 * Why IIFE strings (vs. ES modules): the QuickJS-emscripten runtime has
 * no ES-module loader. The only way to populate the sandbox is via
 * `vm.evalCode(source)`. Bundling each library to a single self-contained
 * IIFE means we don't have to recreate Node's module resolution inside
 * QuickJS — esbuild has already inlined every transitive dep.
 *
 * Invoked by:
 *   - The Vite plugin `scripts/vite-plugin-sandbox-libs.ts` at
 *     dev-server start and at `vite build`.
 *   - The CLI's prebuild step (`cli/package.json#scripts.prebuild`).
 *
 * Output: `shared/scripts/sandbox-libraries/bundle.generated.ts`
 * is gitignored — it's a build artifact regenerated on every build.
 */
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'shared/scripts/sandbox-libraries');
const outFile = path.join(outDir, 'bundle.generated.ts');

/**
 * Library manifest. The `entry` is the package name passed to esbuild;
 * `globalName` becomes the IIFE's window/global identifier. Postman's
 * library list (v12 sandbox reference):
 *   ajv, chai, cheerio, crypto-js, csv-parse/sync, lodash, moment,
 *   postman-collection, tv4, uuid, xml2js
 *
 * `csv-parse/sync` is the sub-entry Postman exposes (`csv-parse/lib/sync`
 * in the old API; modern csv-parse uses `/sync`). xml2js uses `sax` which
 * pulls in a Node `stream` polyfill — esbuild's browser platform handles
 * the substitution via the `buffer` / `stream-browserify` shims when
 * available; we tolerate large output rather than chase micro-optimisations.
 */
const LIBRARIES = [
  { name: 'ajv', entry: 'ajv', globalName: '__sandboxLib_ajv' },
  { name: 'chai', entry: 'chai', globalName: '__sandboxLib_chai' },
  { name: 'cheerio', entry: 'cheerio', globalName: '__sandboxLib_cheerio' },
  { name: 'crypto-js', entry: 'crypto-js', globalName: '__sandboxLib_cryptojs' },
  { name: 'csv-parse/sync', entry: 'csv-parse/sync', globalName: '__sandboxLib_csvparse' },
  { name: 'lodash', entry: 'lodash', globalName: '__sandboxLib_lodash' },
  { name: 'moment', entry: 'moment', globalName: '__sandboxLib_moment' },
  {
    name: 'postman-collection',
    entry: 'postman-collection',
    globalName: '__sandboxLib_pmCollection',
  },
  { name: 'tv4', entry: 'tv4', globalName: '__sandboxLib_tv4' },
  { name: 'uuid', entry: 'uuid', globalName: '__sandboxLib_uuid' },
  { name: 'xml2js', entry: 'xml2js', globalName: '__sandboxLib_xml2js' },
];

/**
 * The sandbox prelude — Node-shim and ES2020 globals the libraries
 * assume exist. Runs *before* any library source. Kept tiny so it stays
 * readable, and inlined into the QuickJS sandbox via the same eval path
 * as the library sources.
 */
const PRELUDE = `
// Minimal Node-style globals the bundled libraries reach for. QuickJS is
// a clean ES2020 runtime — no process, no Buffer, no setImmediate. The
// libraries we ship (cheerio, xml2js, moment, csv-parse) probe for these
// during their UMD bootstrap and silently fall back if absent, but giving
// them harmless stubs avoids noisy first-load errors.
(function () {
  if (typeof globalThis.process === 'undefined') {
    globalThis.process = {
      env: {},
      nextTick: function (cb) { Promise.resolve().then(cb); },
      browser: true,
      version: '',
      versions: {},
      platform: 'browser'
    };
  }
  if (typeof globalThis.setImmediate === 'undefined') {
    globalThis.setImmediate = function (cb) {
      var args = Array.prototype.slice.call(arguments, 1);
      return setTimeout(function () { cb.apply(null, args); }, 0);
    };
  }
  if (typeof globalThis.clearImmediate === 'undefined') {
    globalThis.clearImmediate = function (h) { clearTimeout(h); };
  }
  if (typeof globalThis.global === 'undefined') {
    globalThis.global = globalThis;
  }
  // atob/btoa as proper top-level globals (Postman v12 exposes both).
  // QuickJS ships these natively in newer builds but not the WASM build
  // we use — implement against String.fromCharCode for portability.
  if (typeof globalThis.btoa === 'undefined') {
    globalThis.btoa = function (str) {
      var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
      var out = '';
      for (var i = 0; i < str.length;) {
        var c1 = str.charCodeAt(i++);
        var c2 = i < str.length ? str.charCodeAt(i++) : 0;
        var c3 = i < str.length ? str.charCodeAt(i++) : 0;
        out += chars[c1 >> 2];
        out += chars[((c1 & 3) << 4) | (c2 >> 4)];
        out += chars[((c2 & 0xf) << 2) | (c3 >> 6)];
        out += chars[c3 & 0x3f];
      }
      if (str.length % 3 === 1) out = out.slice(0, -2) + '==';
      else if (str.length % 3 === 2) out = out.slice(0, -1) + '=';
      return out;
    };
  }
  // Minimal EventTarget shim — chai's runtime probes for it during
  // module-init to decide whether it can use real DOM event dispatch.
  // The empty class lets the typeof check resolve to 'function' without
  // wiring an actual event loop.
  if (typeof globalThis.EventTarget === 'undefined') {
    globalThis.EventTarget = function () {};
    globalThis.EventTarget.prototype.addEventListener = function () {};
    globalThis.EventTarget.prototype.removeEventListener = function () {};
    globalThis.EventTarget.prototype.dispatchEvent = function () { return false; };
  }
  if (typeof globalThis.Event === 'undefined') {
    globalThis.Event = function (type, init) {
      this.type = type;
      this.bubbles = !!(init && init.bubbles);
      this.cancelable = !!(init && init.cancelable);
    };
  }
  // csv-parse and a few other libs reach for the global \`Buffer\` (Node
  // legacy). Bridge to a minimal Uint8Array facade — the only methods
  // they actually call are isBuffer / from / byteLength.
  if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = {
      isBuffer: function (v) { return v && typeof v === 'object' && v.byteLength !== undefined && v.constructor && v.constructor.name && /Array$/.test(v.constructor.name); },
      from: function (data) {
        if (typeof data === 'string') {
          var arr = new Uint8Array(data.length);
          for (var i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i) & 0xff;
          return arr;
        }
        return new Uint8Array(data || 0);
      },
      alloc: function (n) { return new Uint8Array(n); },
      byteLength: function (s) { return typeof s === 'string' ? s.length : (s && s.byteLength) || 0; }
    };
  }
  // Other DOM-ish globals chai / moment / xml2js may probe. Empty stubs
  // are enough — the libraries fall back to non-DOM code paths when these
  // exist but behave as no-ops.
  if (typeof globalThis.MessageChannel === 'undefined') {
    globalThis.MessageChannel = function () { return { port1: {}, port2: {} }; };
  }
  if (typeof globalThis.queueMicrotask === 'undefined') {
    globalThis.queueMicrotask = function (cb) { Promise.resolve().then(cb); };
  }
  // Minimal Web Crypto shim — uuid@latest probes for crypto.getRandomValues
  // / crypto.randomUUID. We back both with Math.random — adequate for the
  // sandboxed script use case (Postman scripts that generate IDs don't
  // require cryptographic randomness).
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.getRandomValues) {
    globalThis.crypto = globalThis.crypto || {};
    globalThis.crypto.getRandomValues = function (arr) {
      for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    };
    globalThis.crypto.randomUUID = function () {
      var t = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
      return t.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    };
  }
  if (typeof globalThis.atob === 'undefined') {
    globalThis.atob = function (str) {
      var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      var s = String(str).replace(/=+$/, '');
      var out = '';
      for (var i = 0; i < s.length;) {
        var b1 = chars.indexOf(s[i++]);
        var b2 = i < s.length ? chars.indexOf(s[i++]) : -1;
        var b3 = i < s.length ? chars.indexOf(s[i++]) : -1;
        var b4 = i < s.length ? chars.indexOf(s[i++]) : -1;
        if (b2 >= 0) out += String.fromCharCode((b1 << 2) | (b2 >> 4));
        if (b3 >= 0) out += String.fromCharCode(((b2 & 0xf) << 4) | (b3 >> 2));
        if (b4 >= 0) out += String.fromCharCode(((b3 & 3) << 6) | b4);
      }
      return out;
    };
  }
})();
`;

async function bundleOne({ name, entry, globalName }) {
  try {
    const result = await esbuild.build({
      stdin: {
        contents: `module.exports = require(${JSON.stringify(entry)});`,
        resolveDir: repoRoot,
        loader: 'js',
      },
      bundle: true,
      format: 'iife',
      globalName,
      platform: 'browser',
      target: 'es2020',
      minify: true,
      write: false,
      legalComments: 'none',
      // Provide browser-friendly defaults for Node-only modules; libraries
      // that genuinely need fs/net will fail at runtime, which is the
      // intended sandbox behaviour.
      define: {
        'process.env.NODE_ENV': '"production"',
        global: 'globalThis',
      },
      // The 'sax' dependency that xml2js drags in references 'stream' /
      // 'string_decoder' / 'buffer'. Use external='*' would defeat the
      // bundle; instead, let esbuild substitute browser-empty shims.
      alias: {
        // Map Node built-ins to known browser-empty stubs so we don't fail
        // to resolve. The bundled libs that need real implementations
        // (rare) won't work; the rest carry on.
        fs: path.join(repoRoot, 'scripts/sandbox-shims/empty.js'),
        path: path.join(repoRoot, 'scripts/sandbox-shims/path.js'),
        stream: path.join(repoRoot, 'scripts/sandbox-shims/stream.js'),
        crypto: path.join(repoRoot, 'scripts/sandbox-shims/crypto.js'),
        timers: path.join(repoRoot, 'scripts/sandbox-shims/empty.js'),
        events: path.join(repoRoot, 'scripts/sandbox-shims/events.js'),
        string_decoder: path.join(repoRoot, 'scripts/sandbox-shims/string_decoder.js'),
        util: path.join(repoRoot, 'scripts/sandbox-shims/util.js'),
        buffer: path.join(repoRoot, 'scripts/sandbox-shims/buffer.js'),
      },
    });
    const code = result.outputFiles?.[0]?.text ?? '';
    if (!code) {
      throw new Error(`empty output for ${name}`);
    }
    return code;
  } catch (err) {
    // Re-throw with library context so the build log points at the right
    // missing dep / shim.
    err.message = `[sandbox-libs] failed to bundle ${name}: ${err.message}`;
    throw err;
  }
}

async function ensureShims() {
  const shimDir = path.join(repoRoot, 'scripts/sandbox-shims');
  if (!existsSync(shimDir)) await mkdir(shimDir, { recursive: true });
  const empty = path.join(shimDir, 'empty.js');
  const pathShim = path.join(shimDir, 'path.js');
  const cryptoShim = path.join(shimDir, 'crypto.js');
  if (!existsSync(empty)) {
    await writeFile(empty, 'module.exports = {};\n');
  }
  if (!existsSync(pathShim)) {
    await writeFile(
      pathShim,
      `// Browser shim — only what cheerio/xml2js/csv-parse exercise.
function join() { return Array.prototype.slice.call(arguments).join('/'); }
function resolve() { return Array.prototype.slice.call(arguments).join('/'); }
module.exports = { join: join, resolve: resolve, sep: '/', basename: function (p) { return String(p).split('/').pop(); } };
`
    );
  }
  if (!existsSync(cryptoShim)) {
    await writeFile(
      cryptoShim,
      `// Minimal crypto shim — uuid only needs randomFillSync / randomBytes
// (randomUUID is supplied as a global by the prelude). QuickJS has
// Math.random() (not cryptographically secure but acceptable inside a
// sandbox where the host already prevents network egress).
function randomFillSync(buf) {
  for (var i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}
function randomBytes(n) {
  var arr = new Uint8Array(n);
  return randomFillSync(arr);
}
module.exports = { randomFillSync: randomFillSync, randomBytes: randomBytes };
`
    );
  }

  // Node 'events' — xml2js's parser inherits from EventEmitter. Minimal
  // synchronous emitter (no removeAllListeners semantics, no once-arg
  // protections) is enough for xml2js's `on('end', cb)` pattern.
  const eventsShim = path.join(shimDir, 'events.js');
  if (!existsSync(eventsShim)) {
    await writeFile(
      eventsShim,
      `function EventEmitter() { this._listeners = {}; }
EventEmitter.prototype.on = function (e, fn) {
  (this._listeners[e] = this._listeners[e] || []).push(fn);
  return this;
};
EventEmitter.prototype.addListener = EventEmitter.prototype.on;
EventEmitter.prototype.once = function (e, fn) {
  var self = this;
  function w() { self.off(e, w); fn.apply(null, arguments); }
  return self.on(e, w);
};
EventEmitter.prototype.off = function (e, fn) {
  var l = this._listeners[e]; if (!l) return this;
  this._listeners[e] = l.filter(function (f) { return f !== fn; });
  return this;
};
EventEmitter.prototype.removeListener = EventEmitter.prototype.off;
EventEmitter.prototype.emit = function (e) {
  var l = (this._listeners[e] || []).slice();
  var args = Array.prototype.slice.call(arguments, 1);
  for (var i = 0; i < l.length; i++) l[i].apply(this, args);
  return l.length > 0;
};
EventEmitter.prototype.removeAllListeners = function (e) {
  if (e) delete this._listeners[e]; else this._listeners = {};
  return this;
};
EventEmitter.prototype.setMaxListeners = function () { return this; };
module.exports = EventEmitter;
module.exports.EventEmitter = EventEmitter;
module.exports.default = EventEmitter;
`
    );
  }

  // Node 'string_decoder' — iconv-lite imports StringDecoder for binary
  // transcoding. The TextDecoder API gives us identical UTF-8 semantics
  // for the common cases (postman-collection's encoding path).
  const stringDecoderShim = path.join(shimDir, 'string_decoder.js');
  if (!existsSync(stringDecoderShim)) {
    await writeFile(
      stringDecoderShim,
      `function StringDecoder(encoding) { this.encoding = (encoding || 'utf-8').toLowerCase(); }
StringDecoder.prototype.write = function (buf) {
  if (typeof TextDecoder !== 'undefined') {
    try { return new TextDecoder(this.encoding).decode(buf); } catch (e) {}
  }
  // Final fallback: byte-by-byte string.
  var out = '';
  for (var i = 0; i < (buf && buf.length || 0); i++) out += String.fromCharCode(buf[i]);
  return out;
};
StringDecoder.prototype.end = function () { return ''; };
module.exports = { StringDecoder: StringDecoder };
`
    );
  }

  // Node 'util' — postman-collection uses util.inherits / util.format /
  // util.inspect. Minimal implementations cover the call sites we hit.
  const utilShim = path.join(shimDir, 'util.js');
  if (!existsSync(utilShim)) {
    await writeFile(
      utilShim,
      `function inherits(ctor, superCtor) {
  if (!superCtor || !superCtor.prototype) return;
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: { value: ctor, enumerable: false, writable: true, configurable: true }
  });
}
function format(fmt) {
  var args = Array.prototype.slice.call(arguments, 1);
  if (typeof fmt !== 'string') {
    return [fmt].concat(args).map(function (a) { return inspect(a); }).join(' ');
  }
  var i = 0;
  return fmt.replace(/%[sdjifoO%]/g, function (m) {
    if (m === '%%') return '%';
    var v = args[i++];
    switch (m) {
      case '%s': return String(v);
      case '%d': case '%i': case '%f': return Number(v);
      case '%j': try { return JSON.stringify(v); } catch (e) { return '[circular]'; }
      default: return inspect(v);
    }
  });
}
function inspect(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
function isArray(v) { return Array.isArray(v); }
function isBuffer() { return false; }
function isObject(v) { return v !== null && typeof v === 'object'; }
function isString(v) { return typeof v === 'string'; }
function isNumber(v) { return typeof v === 'number'; }
function isBoolean(v) { return typeof v === 'boolean'; }
function isFunction(v) { return typeof v === 'function'; }
function isNull(v) { return v === null; }
function isUndefined(v) { return v === undefined; }
function isDate(v) { return v instanceof Date; }
function isRegExp(v) { return v instanceof RegExp; }
function deprecate(fn) { return fn; }
module.exports = {
  inherits: inherits, format: format, inspect: inspect,
  isArray: isArray, isBuffer: isBuffer, isObject: isObject,
  isString: isString, isNumber: isNumber, isBoolean: isBoolean,
  isFunction: isFunction, isNull: isNull, isUndefined: isUndefined,
  isDate: isDate, isRegExp: isRegExp, deprecate: deprecate,
  promisify: function (fn) { return function () {
    var self = this, args = Array.prototype.slice.call(arguments);
    return new Promise(function (resolve, reject) {
      args.push(function (err, res) { err ? reject(err) : resolve(res); });
      fn.apply(self, args);
    });
  }; }
};
`
    );
  }

  // Node 'stream' — minimal Readable/Writable for libraries that probe
  // for stream.Readable.prototype. The sandboxed code paths we exercise
  // don't actually drive a stream; they just need the constructor to
  // exist so Object.create / inherits chains resolve.
  const streamShim = path.join(shimDir, 'stream.js');
  if (!existsSync(streamShim)) {
    await writeFile(
      streamShim,
      `function noop() {}
function Stream() {}
Stream.prototype.pipe = noop;
Stream.prototype.on = noop;
Stream.prototype.write = noop;
Stream.prototype.end = noop;
Stream.prototype.emit = noop;
function Readable() { Stream.call(this); }
Readable.prototype = Object.create(Stream.prototype);
function Writable() { Stream.call(this); }
Writable.prototype = Object.create(Stream.prototype);
function Transform() { Stream.call(this); }
Transform.prototype = Object.create(Stream.prototype);
function PassThrough() { Stream.call(this); }
PassThrough.prototype = Object.create(Stream.prototype);
module.exports = {
  Stream: Stream, Readable: Readable, Writable: Writable,
  Transform: Transform, PassThrough: PassThrough
};
module.exports.default = Stream;
`
    );
  }

  // Node 'buffer' — Postman libs (csv-parse, postman-collection) probe
  // for Buffer.isBuffer / Buffer.from. We delegate to Uint8Array so the
  // checks succeed without dragging in a real polyfill.
  const bufferShim = path.join(shimDir, 'buffer.js');
  if (!existsSync(bufferShim)) {
    await writeFile(
      bufferShim,
      `var Buffer = {
  isBuffer: function (v) { return v && typeof v === 'object' && v.byteLength !== undefined; },
  from: function (data, enc) {
    if (typeof data === 'string') {
      var arr = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i) & 0xff;
      return arr;
    }
    return new Uint8Array(data || 0);
  },
  alloc: function (n) { return new Uint8Array(n); },
  allocUnsafe: function (n) { return new Uint8Array(n); },
  byteLength: function (s) { return typeof s === 'string' ? s.length : (s && s.byteLength) || 0; },
  concat: function (arr) {
    var total = 0; for (var i = 0; i < arr.length; i++) total += arr[i].length;
    var out = new Uint8Array(total); var off = 0;
    for (var j = 0; j < arr.length; j++) { out.set(arr[j], off); off += arr[j].length; }
    return out;
  }
};
module.exports = { Buffer: Buffer };
`
    );
  }
}

async function main() {
  await ensureShims();
  await mkdir(outDir, { recursive: true });

  /** @type {Record<string, string>} */
  const sources = {};
  for (const lib of LIBRARIES) {
    process.stdout.write(`[sandbox-libs] bundling ${lib.name}... `);
    try {
      const code = await bundleOne(lib);
      sources[lib.name] = code;
      process.stdout.write(`ok (${(code.length / 1024).toFixed(1)}KB)\n`);
    } catch (err) {
      // Bundling failures for an individual library are surfaced loudly
      // but don't abort the whole build — the sandbox treats absent libs
      // as "not available" and the require() shim throws at call time.
      process.stdout.write(`FAILED\n`);
      console.error(err.message);
      sources[lib.name] = `/* not bundled: ${(err.message || '').replace(/\*\//g, '* /')} */`;
    }
  }

  // Write the generated module. We embed the prelude separately so the
  // executor can choose when (and only once) to eval it. Sources are
  // stored as `Record<string, string>` with the original Postman library
  // names as keys ('csv-parse/sync', 'crypto-js', etc.).
  const tsHeader =
    '// AUTO-GENERATED by scripts/build-sandbox-libs.mjs. DO NOT EDIT BY HAND.\n' +
    '// Re-run `npm run build:sandbox-libs` to regenerate.\n' +
    '/* biome-ignore-all lint */\n' +
    '\n';
  const body =
    `export const SANDBOX_PRELUDE = ${JSON.stringify(PRELUDE)};\n\n` +
    `export const LIBRARY_SOURCES: Record<string, string> = ${JSON.stringify(sources, null, 0)};\n\n` +
    `export const LIBRARY_GLOBAL_NAMES: Record<string, string> = ${JSON.stringify(
      Object.fromEntries(LIBRARIES.map((l) => [l.name, l.globalName])),
      null,
      0
    )};\n`;

  await writeFile(outFile, tsHeader + body);
  process.stdout.write(`[sandbox-libs] wrote ${path.relative(repoRoot, outFile)}\n`);

  // Sanity: surface the total bundle size so the dev knows how big the
  // lazy chunk is. ~200KB gzipped is the budget we set in the plan.
  const totalRaw = Object.values(sources).reduce((a, b) => a + b.length, 0);
  process.stdout.write(
    `[sandbox-libs] total ${(totalRaw / 1024).toFixed(1)}KB raw across ${LIBRARIES.length} libs\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
// readFile imported above for future incremental-build use (manifest hash).
void readFile;
