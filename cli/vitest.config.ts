import path from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = path.resolve(__dirname, '..');

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist', 'fixtures'],
  },
  resolve: {
    alias: {
      '@': path.resolve(repoRoot, 'src'),
      '@shared': path.resolve(repoRoot, 'shared'),
    },
  },
});
