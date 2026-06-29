import { defineConfig } from 'vitest/config';

// Isolated from the renderer's root vitest config (jsdom + RTL setup). The
// extension's pure seams run in plain Node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    root: __dirname,
  },
});
