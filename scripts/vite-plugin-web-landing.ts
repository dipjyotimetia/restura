/**
 * Cloudflare Pages site layout for restura.dev.
 *
 * The web build (and only that build) ships a static marketing landing page at
 * `/` and the app at `/app/`:
 *
 *   dist/web/client/index.html      → dist/web/client/app/index.html  (the app)
 *   site/index.html                 → dist/web/client/index.html      (landing)
 *   site/landing.js                 → dist/web/client/landing-<hash>.js
 *   site/404.html, site/llms.txt    → dist/web/client/ (as-is)
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

const SITE = 'https://restura.dev';

/**
 * The app shell at `/app/` has no crawlable content and the same title as the
 * landing page; keep it out of the index (self-canonical + noindex) so it
 * never competes with `/`. Throws if the expected tags moved, so SEO can't
 * silently regress when index.html changes.
 */
export function retargetAppHead(html: string): string {
  const swaps: Array<[string, string]> = [
    [`<link rel="canonical" href="${SITE}/" />`, `<link rel="canonical" href="${SITE}/app/" />`],
    [
      '<meta name="robots" content="index, follow" />',
      '<meta name="robots" content="noindex, follow" />',
    ],
    [
      `<meta property="og:url" content="${SITE}/" />`,
      `<meta property="og:url" content="${SITE}/app/" />`,
    ],
  ];
  let out = html;
  for (const [from, to] of swaps) {
    if (!out.includes(from)) throw new Error(`[web-landing] app index.html is missing: ${from}`);
    out = out.replace(from, to);
  }
  return out;
}

/** Pure layout step, exported for tests: run against a built client dir. */
export function layoutWebSite(outDir: string, sourceDir: string = siteDir): void {
  const appIndex = path.join(outDir, 'index.html');
  if (!existsSync(appIndex)) {
    throw new Error(`[web-landing] expected the built app at ${appIndex}`);
  }
  mkdirSync(path.join(outDir, 'app'), { recursive: true });
  const movedApp = path.join(outDir, 'app', 'index.html');
  renameSync(appIndex, movedApp);
  writeFileSync(movedApp, retargetAppHead(readFileSync(movedApp, 'utf8')));

  // A real 404 page: without one, Pages treats the site as an SPA and answers
  // every unknown path with the landing page and a 200 (a soft 404 to search
  // engines). The app uses hash routing, so it never needs the fallback.
  writeFileSync(path.join(outDir, '404.html'), readFileSync(path.join(sourceDir, '404.html')));

  // Plain-text summary for AI agents and answer engines (llmstxt.org).
  writeFileSync(path.join(outDir, 'llms.txt'), readFileSync(path.join(sourceDir, 'llms.txt')));

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
