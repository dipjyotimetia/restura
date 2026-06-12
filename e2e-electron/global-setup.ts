import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

/** Fail fast with a clear message when the desktop build artifacts are missing. */
export default function globalSetup(): void {
  const required = [
    path.join(ROOT, 'dist/electron/electron/main/main.js'),
    path.join(ROOT, 'dist/electron/electron/main/preload.js'),
    path.join(ROOT, 'dist/web/index.html'),
  ];
  const missing = required.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      `Desktop build artifacts missing:\n  ${missing.join('\n  ')}\n` +
        'Run `npm run test:e2e:electron:build` first.'
    );
  }
}
