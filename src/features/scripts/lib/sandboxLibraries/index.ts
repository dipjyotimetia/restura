/**
 * Public entry for the Postman-compatible library bundle.
 *
 * `loadSandboxLibraries()` is a thin dynamic-import wrapper around the
 * generated `bundle.generated.ts` module. The dynamic import means Vite
 * code-splits the (~2MB raw / ~600KB gz) library bundle into its own
 * async chunk — the entry bundle stays slim, and the libraries only
 * load once a script actually runs.
 *
 * The QuickJS sandbox consumes these as strings (it has no ES-module
 * loader). The exported `installRequireShim()` produces the JS source
 * the executor eval's inside QuickJS to wire up `require(name)`.
 */
import { LIBRARY_SOURCES, LIBRARY_GLOBAL_NAMES, SANDBOX_PRELUDE } from './bundle.generated';

export interface SandboxLibraryBundle {
  /** Per-library IIFE source. Eval'd inside QuickJS. */
  sources: Record<string, string>;
  /** Per-library `globalThis.<x>` name the IIFE assigns its exports to. */
  globalNames: Record<string, string>;
  /** Tiny prelude with Node-built-in shims + atob/btoa. Runs before any lib. */
  prelude: string;
}

let cached: Promise<SandboxLibraryBundle> | null = null;

/**
 * Lazy-load the library bundle. Resolves to the same module object on
 * every call within a renderer session — the cost is paid exactly once,
 * the first time a script runs.
 */
export function loadSandboxLibraries(): Promise<SandboxLibraryBundle> {
  if (!cached) {
    cached = Promise.resolve({
      sources: LIBRARY_SOURCES,
      globalNames: LIBRARY_GLOBAL_NAMES,
      prelude: SANDBOX_PRELUDE,
    });
  }
  return cached;
}

/**
 * Source for the `require()` shim inside QuickJS. After every library
 * IIFE has run (each one assigns its exports to its `globalThis.<name>`),
 * this shim looks up the global by the manifest key the user passed.
 */
export function buildRequireShimSource(globalNames: Record<string, string>): string {
  // Inline the manifest as a JSON object literal. The shim is a couple
  // dozen lines of plain JS — easier to read than building it via
  // QuickJS handle manipulation.
  return (
    'globalThis.__SANDBOX_REQUIRE_MAP = ' +
    JSON.stringify(globalNames) +
    ';\n' +
    `globalThis.__SANDBOX_REQUIRE_CACHE = {};\n` +
    `globalThis.require = function (name) {\n` +
    `  if (globalThis.__SANDBOX_REQUIRE_CACHE[name] !== undefined) {\n` +
    `    return globalThis.__SANDBOX_REQUIRE_CACHE[name];\n` +
    `  }\n` +
    `  var globalName = globalThis.__SANDBOX_REQUIRE_MAP[name];\n` +
    `  if (!globalName) {\n` +
    `    throw new Error("Cannot find module '" + name + "'");\n` +
    `  }\n` +
    `  var mod = globalThis[globalName];\n` +
    `  if (mod === undefined) {\n` +
    `    throw new Error("Module '" + name + "' was registered but its source did not load");\n` +
    `  }\n` +
    `  // Unwrap esbuild's IIFE-default-export envelope: \`{ default: actual }\`\n` +
    `  // when the underlying entry was CJS \`module.exports = X\`. Postman's\n` +
    `  // contract is that \`require('lodash')\` returns the lodash function\n` +
    `  // directly, not \`{ default: lodash }\`.\n` +
    `  var unwrapped = (mod && typeof mod === 'object' && 'default' in mod && Object.keys(mod).length === 1)\n` +
    `    ? mod.default : mod;\n` +
    `  globalThis.__SANDBOX_REQUIRE_CACHE[name] = unwrapped;\n` +
    `  return unwrapped;\n` +
    `};\n`
  );
}
