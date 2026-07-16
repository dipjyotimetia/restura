import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Isolated from the renderer's root vitest config (jsdom + RTL setup). The
// extension's pure seams run in plain Node.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../../shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    root: __dirname,
  },
});
