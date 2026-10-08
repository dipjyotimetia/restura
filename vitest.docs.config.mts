import { defineConfig } from 'vitest/config';

// The Astro site is a standalone frontend. Keep its interaction tests separate
// from the renderer/Worker coverage budget while enforcing them in CI.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['docs-site/tests/**/*.test.ts'],
    globals: false,
    pool: 'forks',
    isolate: true,
  },
});
