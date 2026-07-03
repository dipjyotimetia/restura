// @vitest-environment node
//
// Structural guards for the Electron security posture in main.ts (same
// source-level style as ipc-surface.test.ts):
//   1. Default-deny web permission handlers are wired on session.defaultSession
//      and the allowlist stays minimal (clipboard-sanitized-write only).
//   2. The production header CSP in main.ts and the <meta> CSP fallback in
//      vite.config.mts stay in sync — the two are maintained by hand in two
//      processes, and nothing else checks their parity.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(process.cwd());
const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main/main.ts'), 'utf8');
const viteSrc = fs.readFileSync(path.join(ROOT, 'vite.config.mts'), 'utf8');

/** Parse a CSP policy string into a Map of directive → sources. */
function parseCsp(policy: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...sources] = trimmed.split(/\s+/);
    directives.set(name!, sources.join(' '));
  }
  return directives;
}

/**
 * Extract the header CSP from main.ts. The policy is written as adjacent
 * string-literal concatenation inside the 'Content-Security-Policy' array —
 * pull every double-quoted segment between the header key and the closing
 * bracket and join them.
 */
function extractMainCsp(): string {
  const start = mainSrc.indexOf("'Content-Security-Policy': [");
  expect(start).toBeGreaterThan(-1);
  const end = mainSrc.indexOf(']', start);
  const block = mainSrc.slice(start, end);
  const segments = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  expect(segments.length).toBeGreaterThan(0);
  return segments.join('');
}

/** Extract ELECTRON_RENDERER_CSP entries from vite.config.mts. */
function extractViteCsp(): string {
  const start = viteSrc.indexOf('const ELECTRON_RENDERER_CSP = [');
  expect(start).toBeGreaterThan(-1);
  const end = viteSrc.indexOf('].join', start);
  const block = viteSrc.slice(start, end);
  const segments = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  expect(segments.length).toBeGreaterThan(0);
  return segments.join('; ');
}

describe('web permission handlers (default deny)', () => {
  it('wires setPermissionRequestHandler and setPermissionCheckHandler on the default session', () => {
    expect(mainSrc).toMatch(/session\.defaultSession\.setPermissionRequestHandler\(/);
    expect(mainSrc).toMatch(/session\.defaultSession\.setPermissionCheckHandler\(/);
  });

  it('calls setupPermissionHandlers during app startup', () => {
    // Registration exists AND is invoked — a defined-but-never-called setup
    // function would silently revert to Electron's default-grant behavior.
    expect(mainSrc).toMatch(/^\s*setupPermissionHandlers\(\);/m);
  });

  it('allowlists only clipboard-sanitized-write', () => {
    const match = mainSrc.match(/ALLOWED_WEB_PERMISSIONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(match).not.toBeNull();
    const entries = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // Growing this list is a security decision — update this test deliberately
    // alongside a rationale in main.ts if a new permission is ever needed.
    expect(entries).toEqual(['clipboard-sanitized-write']);
  });
});

describe('CSP parity: main.ts header ↔ vite.config.mts meta fallback', () => {
  it('the two policies define identical directives (meta omits header-only frame-ancestors)', () => {
    const header = parseCsp(extractMainCsp());
    const meta = parseCsp(extractViteCsp());

    // frame-ancestors is header-only (ignored in <meta> CSP), so the meta
    // policy legitimately omits it. Everything else must match exactly.
    const headerWithoutFrameAncestors = new Map(header);
    headerWithoutFrameAncestors.delete('frame-ancestors');

    expect(Object.fromEntries(meta)).toEqual(Object.fromEntries(headerWithoutFrameAncestors));
  });

  it('both policies pin the hardening directives', () => {
    for (const policy of [parseCsp(extractMainCsp()), parseCsp(extractViteCsp())]) {
      expect(policy.get('object-src')).toBe("'none'");
      expect(policy.get('worker-src')).toBe("'self' file:");
      expect(policy.get('base-uri')).toBe("'self'");
      // script-src must never grow 'unsafe-eval' — only WASM eval for QuickJS.
      const scriptSources = policy.get('script-src')!.split(/\s+/);
      expect(scriptSources).toContain("'wasm-unsafe-eval'");
      expect(scriptSources).not.toContain("'unsafe-eval'");
    }
  });
});
