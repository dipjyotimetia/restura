import { defineConfig } from '@vscode/test-cli';

// Integration tests run inside a real VS Code instance against the sample
// collection fixture. Unit tests (the fast suite) live under test/unit and run
// via vitest without the host.
export default defineConfig({
  files: 'test/integration/**/*.test.mjs',
  workspaceFolder: 'test/fixtures/sample-collection',
  mocha: { timeout: 20000 },
});
