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
      },
    },
  },
});
