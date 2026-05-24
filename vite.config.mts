import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import path from 'path';

const isElectronBuild = process.env.VITE_IS_ELECTRON_BUILD === 'true';
// Self-hosted Docker build: emit a plain SPA bundle and skip the Cloudflare
// plugin (no Worker is bundled here; the Node entry at `worker/node-entry.ts`
// is built separately and serves the SPA + /api).
const isDockerBuild = process.env.VITE_IS_DOCKER_BUILD === 'true';
const skipCloudflare = isElectronBuild || isDockerBuild;

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    ...(skipCloudflare ? [] : [cloudflare()]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
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
