import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Response-preview security boundary. The "Preview" tab renders an UNTRUSTED
 * upstream response body into an iframe via `srcDoc`. The sandbox MUST NOT
 * combine `allow-scripts` with `allow-same-origin` — together they defeat the
 * isolation and let response scripts run in the renderer's own origin (reaching
 * its cookies/storage and the same-origin /api proxy on the web build).
 *
 * ResponseViewer is a large store-coupled component (Monaco/motion lazy chunks)
 * whose Preview tab only appears for HTML content, so a full mount-and-navigate
 * test is brittle. This source-level assertion captures the exact invariant we
 * care about and fails loudly if any iframe in the file regresses.
 */
const SOURCE = readFileSync(
  resolve(process.cwd(), 'src/components/shared/ResponseViewer.tsx'),
  'utf8'
);

describe('ResponseViewer — preview iframe sandbox', () => {
  it('never combines allow-scripts with allow-same-origin on any iframe sandbox', () => {
    const sandboxAttrs = [...SOURCE.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(sandboxAttrs.length).toBeGreaterThan(0);
    for (const value of sandboxAttrs) {
      expect(value.split(/\s+/)).not.toContain('allow-same-origin');
    }
  });
});
