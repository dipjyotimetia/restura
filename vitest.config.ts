import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // `node_modules/electron/index.js` runs downloadElectron() at module-load
    // when `path.txt` is missing (fresh installs, or sandboxes where the binary
    // download is blocked by egress policy), crashing every suite that
    // `import 'electron'` even though they all `vi.mock('electron')` and never
    // touch the real binary. Short-circuit the download to a stub path — the
    // mock takes over from there. CI sets this at the workflow level; its value
    // wins when present, and the electron-smoke / e2e-electron jobs (which need
    // the real binary) don't run vitest, so they're unaffected.
    env: {
      ELECTRON_OVERRIDE_DIST_PATH: process.env.ELECTRON_OVERRIDE_DIST_PATH ?? '/tmp',
    },
    // Inline graphql-ws so vite (with resolve.dedupe below) gives it the SAME
    // graphql copy as our in-process mock schema — otherwise the server-side
    // validate throws "Duplicate graphql modules" on cross-realm schemas.
    server: { deps: { inline: ['graphql-ws'] } },
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'tests/**/*.{test,spec}.{ts,tsx}',
      'electron/main/**/__tests__/**/*.{test,spec}.ts',
      'worker/**/__tests__/**/*.{test,spec}.ts',
      'echo/**/__tests__/**/*.{test,spec}.ts',
      'shared/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['node_modules', 'dist', 'out', '.next'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        // Dev/test tooling, not production code: e2e mocks + the local echo stack.
        'e2e/',
        'echo-local/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/',
        'electron/',
        // Platform/runtime-specific — depend on Electron IPC or IndexedDB
        'src/lib/shared/platform.ts',
        'src/lib/shared/database.ts',
        'src/lib/shared/dexie-storage.ts',
        // Worker networking primitives (TCP proxy, MCP handler)
        'worker/shared/tcp-proxy.ts',
        'worker/handlers/mcp.ts',
        // Browser WebSocket API — untestable in jsdom without real browser
        'src/features/websocket/lib/websocketManager.ts',
        // Script execution sandbox (QuickJS) — integration-only
        'src/features/scripts/lib/scriptExecutor.ts',
        // HTTP executor — complex Axios/Electron async, covered by e2e
        'src/features/http/lib/requestExecutor.ts',
        // Cookie store — tough-cookie integration, covered by e2e
        'src/features/http/store/useCookieStore.ts',
        // Proxy helper functions using Electron API — mocked in e2e
        'src/features/http/lib/proxyHelper.ts',
        // Collection exporters — integration-tested via export flows
        'src/features/collections/lib/exporters.ts',
        // Radix UI wrapper primitives — mostly wrappers, branch-heavy Radix internals
        'src/components/ui/context-menu.tsx',
        'src/components/ui/motion.tsx',
      ],
      thresholds: {
        // Global coverage spans the renderer, stores, protocol managers, and
        // Worker. Use an uncovered-item budget so the gate is enforceable and
        // any newly added untested production code fails it. Percentage targets
        // had drifted below their 2026 snapshot and CI silently disabled them.
        lines: -4378,
        functions: -1344,
        branches: -5226,
        statements: -5321,
        // The backend-agnostic protocol core is the security/parity boundary;
        // keep substantially stronger percentage guarantees here.
        'shared/protocol/**': {
          lines: 90,
          functions: 88,
          branches: 75,
          statements: 88,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
      // cloudflare:sockets is a runtime-only Cloudflare Workers API; stub it in tests
      'cloudflare:sockets': path.resolve(__dirname, './tests/__mocks__/cloudflare-sockets.ts'),
    },
    // graphql is instanceof-sensitive (assertValidSchema cross-instance throws).
    // Force a single copy so in-process graphql-ws and our mock schema agree —
    // matches the single-instance resolution of the real Node runtime.
    dedupe: ['graphql'],
  },
});
