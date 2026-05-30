import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'path';
import { sandboxLibsPlugin } from './scripts/vite-plugin-sandbox-libs';

const isElectronBuild = process.env.VITE_IS_ELECTRON_BUILD === 'true';
// Self-hosted Docker build: emit a plain SPA bundle and skip the Cloudflare
// plugin (no Worker is bundled here; the Node entry at `worker/node-entry.ts`
// is built separately and serves the SPA + /api).
const isDockerBuild = process.env.VITE_IS_DOCKER_BUILD === 'true';
const skipCloudflare = isElectronBuild || isDockerBuild;

export default defineConfig({
  plugins: [
    sandboxLibsPlugin(),
    react(),
    tailwind(),
    ...(skipCloudflare ? [] : [cloudflare()]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
      // `@usebruno/lang` does `const ohm = require('ohm-js'); ohm.grammar(...)`.
      // ohm-js's ESM build (`module: dist/ohm.esm.js`) exports `ohm` as the
      // default export, so Vite's ESM interop hands back `{ default, extras }`
      // and `.grammar` is undefined. Pin to the CJS entry — Vite's CJS plugin
      // unwraps `module.exports = ohm` correctly. See docs/BUILD_QUIRKS.md.
      'ohm-js': path.resolve(__dirname, './node_modules/ohm-js/index.js'),
      // Vite (+ the Cloudflare plugin) externalises the bare `buffer` import
      // because it's a Node built-in. swagger-parser needs the polyfill at
      // runtime to dereference $refs. Force-resolve to the npm `buffer`
      // package so `import { Buffer } from 'buffer'` works in the renderer.
      // See docs/BUILD_QUIRKS.md.
      buffer: path.resolve(__dirname, './node_modules/buffer/index.js'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist/web',
    assetsDir: 'assets',
    sourcemap: process.env.NODE_ENV === 'production' ? false : true,
    ...(isElectronBuild && { target: 'esnext' }),
    // Split the large, stable vendor libraries that sit in the *eager* import
    // graph (the renderer entry) into their own chunks. On desktop the renderer
    // loads from file://, so this isn't about network parallelism — it lets
    // V8's code cache reuse these chunks' compiled bytecode across app-version
    // bumps (our app code changes; React/Radix/etc. don't), and keeps the entry
    // chunk itself smaller to parse on a cold start.
    //
    // Scoped to the SPA builds where the Cloudflare plugin is absent (Electron +
    // self-hosted Docker). The Cloudflare web build keeps Vite's default
    // chunking so we don't perturb the separately-deployed Worker bundle.
    //
    // Only libraries known to be in the eager graph are bucketed here. Heavy
    // libs that are already isolated behind dynamic import() — monaco-editor,
    // @xyflow/react, quickjs-emscripten, postman-collection — are deliberately
    // left to Vite's default splitting so they stay lazily loaded.
    ...(skipCloudflare && {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            // React core only — the `[\\/]…[\\/]` boundaries match these exact
            // package dirs. Peripheral `react-*` libs (react-hotkeys-hook,
            // react-resizable-panels, react-syntax-highlighter) deliberately
            // fall through to Vite's default splitting; they're small or already
            // route-lazy, so bucketing them here would buy nothing.
            if (
              /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(
                id
              )
            ) {
              return 'vendor-react';
            }
            if (id.includes('/node_modules/@radix-ui/')) return 'vendor-radix';
            if (
              id.includes('/node_modules/framer-motion/') ||
              id.includes('/node_modules/motion-dom/') ||
              id.includes('/node_modules/motion-utils/')
            ) {
              return 'vendor-motion';
            }
            if (id.includes('/node_modules/zod/')) return 'vendor-zod';
            return undefined;
          },
        },
      },
    }),
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(
      process.env.npm_package_version || '0.1.0'
    ),
    // Surfaced by the Worker's /health endpoint (worker/app.ts:VERSION).
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.1.0'),
    'import.meta.env.VITE_IS_ELECTRON_BUILD': JSON.stringify(
      isElectronBuild ? 'true' : 'false'
    ),
    'import.meta.env.VITE_IS_DOCKER_BUILD': JSON.stringify(
      isDockerBuild ? 'true' : 'false'
    ),
    // Echo-server URL overrides for self-hosted deployments that can't reach
    // the public `echo.restura.dev`. Empty string at build time means the
    // renderer falls back to its compiled defaults (`echo-defaults.ts`).
    'import.meta.env.VITE_ECHO_HTTP_URL': JSON.stringify(
      process.env.VITE_ECHO_HTTP_URL ?? ''
    ),
    'import.meta.env.VITE_ECHO_GRPC_URL': JSON.stringify(
      process.env.VITE_ECHO_GRPC_URL ?? ''
    ),
    'import.meta.env.VITE_ECHO_GRAPHQL_URL': JSON.stringify(
      process.env.VITE_ECHO_GRAPHQL_URL ?? ''
    ),
    'import.meta.env.VITE_ECHO_WS_URL': JSON.stringify(
      process.env.VITE_ECHO_WS_URL ?? ''
    ),
    'import.meta.env.VITE_ECHO_SSE_URL': JSON.stringify(
      process.env.VITE_ECHO_SSE_URL ?? ''
    ),
  },
  ...(isElectronBuild && { base: './' }),
  optimizeDeps: {
    exclude: ['quickjs-emscripten'],
  },
});
