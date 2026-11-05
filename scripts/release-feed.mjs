#!/usr/bin/env node
// Builds the static release-notes feed the app reads instead of calling
// api.github.com (anonymous: 60 requests/hour/IP, shared by whole networks).
//
//   gh api --paginate --slurp repos/OWNER/REPO/releases > releases-raw.json
//   node scripts/release-feed.mjs releases-raw.json <out-dir>
//
// Writes <out-dir>/releases.json and <out-dir>/_headers, ready for
// `wrangler pages deploy <out-dir>`. Run by .github/workflows/release-feed.yml
// with an authenticated token (1,000+/hr), once per published release.
//
// CONTRACT: the shape of releases.json is parsed by `ReleaseFeedSchema` in
// src/lib/shared/release-notes.ts. Change both together (bump FEED_VERSION).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEED_VERSION = 1;
/** Newest releases kept in the feed; bounds the file the app downloads. */
export const FEED_LIMIT = 100;

/**
 * CORS is open on purpose: the feed is public data, and the Electron renderer
 * loads from file:// (Origin: null), which only `*` matches.
 */
export const FEED_HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer

/releases.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300, must-revalidate
  Content-Type: application/json; charset=utf-8
`;

/**
 * `gh api --paginate --slurp` emits an array of pages; a plain API response is
 * a single array. Accept both.
 */
function flatten(raw) {
  if (!Array.isArray(raw)) throw new Error('Expected a JSON array of GitHub releases.');
  return raw.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
}

/**
 * @param {unknown} raw GitHub "list releases" response(s).
 * @param {{ now?: Date, limit?: number }} [options]
 */
export function buildFeed(raw, { now = new Date(), limit = FEED_LIMIT } = {}) {
  const releases = flatten(raw)
    .filter((release) => release && release.draft !== true && release.published_at)
    .map((release) => {
      for (const key of ['id', 'tag_name', 'html_url', 'published_at']) {
        if (release[key] == null || release[key] === '') {
          throw new Error(`Release is missing "${key}": ${JSON.stringify(release).slice(0, 200)}`);
        }
      }
      return {
        id: release.id,
        tag_name: release.tag_name,
        name: release.name?.trim() || release.tag_name,
        body: release.body ?? '',
        html_url: release.html_url,
        published_at: release.published_at,
        prerelease: release.prerelease === true,
      };
    })
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, limit);

  if (releases.length === 0) {
    // Never publish an empty feed over a good one; the job fails instead.
    throw new Error('No published releases found; refusing to build an empty feed.');
  }

  return { version: FEED_VERSION, generated_at: now.toISOString(), releases };
}

export function writeFeed(raw, outDir, options) {
  const feed = buildFeed(raw, options);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'releases.json'), `${JSON.stringify(feed)}\n`);
  writeFileSync(join(outDir, '_headers'), FEED_HEADERS);
  return feed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, outDir] = process.argv.slice(2);
  if (!input || !outDir) {
    console.error('usage: node scripts/release-feed.mjs <releases-raw.json> <out-dir>');
    process.exit(2);
  }
  try {
    const feed = writeFeed(JSON.parse(readFileSync(input, 'utf8')), outDir);
    console.log(`Wrote ${feed.releases.length} releases (newest ${feed.releases[0].tag_name}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
