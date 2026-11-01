/**
 * Cloudflare Pages site layout for restura.dev.
 *
 * The web build (and only that build) ships a static marketing landing page at
 * `/` and the app at `/app/`:
 *
 *   dist/web/client/index.html      → dist/web/client/app/index.html  (the app)
 *   site/index.html                 → dist/web/client/index.html      (landing)
 *   site/landing.js                 → dist/web/client/landing-<hash>.js
 *
 * The app's assets are root-absolute (`/assets/…`, base `/`) and it uses hash
 * routing, so it runs unchanged from `/app/`; IndexedDB is per-origin, so
 * existing users keep their data. `site/landing.js` forwards returning users,
 * the installed PWA and old `/#/…` URLs to `/app/`.
 *
 * Electron (`file://`, base `./`) and the self-hosted Docker build keep the app
 * at `/` — this plugin is only registered alongside the Cloudflare plugin.
 * In dev, Vite serves the landing page as-is at `/site/`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(__dirname, '..', 'site');

/** Pure layout step, exported for tests: run against a built client dir. */
export function layoutWebSite(outDir: string, sourceDir: string = siteDir): void {
  const appIndex = path.join(outDir, 'index.html');
  if (!existsSync(appIndex)) {
    throw new Error(`[web-landing] expected the built app at ${appIndex}`);
  }
  mkdirSync(path.join(outDir, 'app'), { recursive: true });
  renameSync(appIndex, path.join(outDir, 'app', 'index.html'));

  // Content-hash the script: `/*.js` is served `immutable` (public/_headers).
  const script = readFileSync(path.join(sourceDir, 'landing.js'));
  const hash = createHash('sha256').update(script).digest('hex').slice(0, 10);
  const scriptName = `landing-${hash}.js`;
  writeFileSync(path.join(outDir, scriptName), script);

  const html = readFileSync(path.join(sourceDir, 'index.html'), 'utf8');
  const ref = 'src="./landing.js"';
  if (!html.includes(ref)) {
    throw new Error(`[web-landing] site/index.html must load the script via ${ref}`);
  }
  writeFileSync(appIndex, html.replace(ref, `src="/${scriptName}"`));
}

export function webLandingPlugin(): Plugin {
  return {
    name: 'restura-web-landing',
    apply: 'build',
    // The Cloudflare plugin also builds the Worker environment; only the
    // client (static Pages) output gets the landing layout.
    applyToEnvironment: (environment) => environment.name === 'client',
    writeBundle(options) {
      if (!options.dir) throw new Error('[web-landing] client build has no output dir');
      layoutWebSite(options.dir);
    },
  };
}
