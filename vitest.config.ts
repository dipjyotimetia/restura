import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'tests/**/*.{test,spec}.{ts,tsx}',
      'electron/main/__tests__/**/*.{test,spec}.ts',
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
        lines: 80,
        functions: 78,
        branches: 61,
        statements: 78,
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
  },
});
