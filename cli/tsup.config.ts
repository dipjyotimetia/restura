import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  clean: true,
  tsconfig: 'tsconfig.json',
  // Bundled CommonJS dependencies (e.g. @opentelemetry/sdk-trace-node) call
  // `require('async_hooks')` at load time; an ESM bundle has no `require`, so
  // the CLI crashed on startup. Give the bundle a real one.
  banner: {
    js: "import { createRequire as __resturaCreateRequire } from 'node:module';\nconst require = __resturaCreateRequire(import.meta.url);",
  },
});
