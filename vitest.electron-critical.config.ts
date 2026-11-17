import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
      'cloudflare:sockets': path.resolve(__dirname, './tests/__mocks__/cloudflare-sockets.ts'),
    },
    dedupe: ['graphql'],
  },
  test: {
    environment: 'node',
    env: {
      ELECTRON_OVERRIDE_DIST_PATH: process.env.ELECTRON_OVERRIDE_DIST_PATH ?? '/tmp',
    },
    globals: true,
    include: [
      'electron/main/__tests__/execution-policy.test.ts',
      'electron/main/__tests__/secret-handle-store.test.ts',
      'electron/main/__tests__/http-execution-policy.test.ts',
      'electron/main/__tests__/http-handler*.test.ts',
      'electron/main/ipc/__tests__/**/*.test.ts',
      'electron/main/ipc/validators/__tests__/**/*.test.ts',
      'electron/main/__tests__/startup-resilience.test.ts',
      'electron/main/__tests__/startup-missing-native.test.ts',
      'electron/main/__tests__/window-manager-cascade.test.ts',
      'electron/main/lifecycle/__tests__/process-guard.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      include: [
        'electron/main/handlers/http-handler.ts',
        'electron/main/handlers/http-response-stream.ts',
        'electron/main/handlers/http-secure-connection.ts',
        'electron/main/ipc/validators/boundary.ts',
        'electron/main/security/execution-policy.ts',
        'electron/main/security/secret-handle-store.ts',
        'electron/main/lifecycle/feature-loader.ts',
        'electron/main/lifecycle/process-guard.ts',
        'electron/main/lifecycle/renderer-recovery.ts',
        'electron/main/window-manager.ts',
      ],
      thresholds: {
        'electron/main/handlers/http-handler.ts': {
          statements: 46,
          branches: 34,
          functions: 42,
          lines: 47,
        },
        'electron/main/handlers/http-response-stream.ts': {
          statements: 85,
          branches: 100,
          functions: 85,
          lines: 84,
        },
        'electron/main/handlers/http-secure-connection.ts': {
          statements: 57,
          branches: 35,
          functions: 68,
          lines: 60,
        },
        'electron/main/ipc/validators/boundary.ts': {
          statements: 70,
          branches: 46,
          functions: 60,
          lines: 73,
        },
        'electron/main/security/execution-policy.ts': {
          statements: 77,
          branches: 83,
          functions: 75,
          lines: 77,
        },
        'electron/main/security/secret-handle-store.ts': {
          statements: 90,
          branches: 75,
          functions: 94,
          lines: 90,
        },
        // Launch path (#1353). feature-loader's one uncovered branch is an
        // Error with an empty stack, which Node does not produce here.
        'electron/main/lifecycle/feature-loader.ts': {
          statements: 100,
          branches: 80,
          functions: 100,
          lines: 100,
        },
        'electron/main/lifecycle/process-guard.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'electron/main/lifecycle/renderer-recovery.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // createMainWindow, saved state, and the smoke-window hook. The menu
        // and renderer-crash dialog stay outside this floor.
        'electron/main/window-manager.ts': {
          statements: 46,
          branches: 26,
          functions: 60,
          lines: 50,
        },
      },
    },
  },
});
