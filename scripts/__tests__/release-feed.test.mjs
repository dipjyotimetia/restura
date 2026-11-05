import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildFeed, FEED_HEADERS, FEED_VERSION, writeFeed } from '../release-feed.mjs';

const release = (id, tag, overrides = {}) => ({
  id,
  tag_name: tag,
  name: tag,
  body: `Notes for ${tag}`,
  html_url: `https://github.com/dipjyotimetia/restura/releases/tag/${tag}`,
  published_at: `2026-11-0${id}T12:00:00Z`,
  draft: false,
  prerelease: false,
  // Fields the app never reads must not leak into the feed.
  author: { login: 'someone' },
  assets: [{ id: 1 }],
  ...overrides,
});

const NOW = new Date('2026-11-05T00:00:00Z');

test('keeps only the fields the app reads, newest first', () => {
  const feed = buildFeed([release(1, 'v1.0.0'), release(3, 'v1.2.0'), release(2, 'v1.1.0')], {
    now: NOW,
  });
  assert.equal(feed.version, FEED_VERSION);
  assert.equal(feed.generated_at, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(
    feed.releases.map((r) => r.tag_name),
    ['v1.2.0', 'v1.1.0', 'v1.0.0']
  );
  assert.deepEqual(Object.keys(feed.releases[0]).sort(), [
    'body',
    'html_url',
    'id',
    'name',
    'prerelease',
    'published_at',
    'tag_name',
  ]);
});

test('drops drafts and releases without a publish date', () => {
  const feed = buildFeed(
    [
      release(1, 'v1.0.0'),
      release(2, 'v1.1.0', { draft: true }),
      release(3, 'v1.2.0', { published_at: null }),
    ],
    { now: NOW }
  );
  assert.deepEqual(
    feed.releases.map((r) => r.tag_name),
    ['v1.0.0']
  );
});

test('keeps prereleases (the app filters by channel) and normalizes name/body', () => {
  const feed = buildFeed(
    [release(1, 'v1.0.0-beta.1', { prerelease: true, name: '  ', body: null })],
    { now: NOW }
  );
  assert.deepEqual(feed.releases[0], {
    id: 1,
    tag_name: 'v1.0.0-beta.1',
    name: 'v1.0.0-beta.1',
    body: '',
    html_url: 'https://github.com/dipjyotimetia/restura/releases/tag/v1.0.0-beta.1',
    published_at: '2026-11-01T12:00:00Z',
    prerelease: true,
  });
});

test('accepts the paged array that `gh api --paginate --slurp` emits', () => {
  const feed = buildFeed([[release(2, 'v1.1.0')], [release(1, 'v1.0.0')]], { now: NOW });
  assert.equal(feed.releases.length, 2);
});

test('caps the feed at the newest N releases', () => {
  const feed = buildFeed([release(1, 'v1.0.0'), release(2, 'v1.1.0'), release(3, 'v1.2.0')], {
    now: NOW,
    limit: 2,
  });
  assert.deepEqual(
    feed.releases.map((r) => r.tag_name),
    ['v1.2.0', 'v1.1.0']
  );
});

test('refuses to build an empty feed so a good one is never overwritten', () => {
  assert.throws(() => buildFeed([release(1, 'v1.0.0', { draft: true })]), /empty feed/);
  assert.throws(() => buildFeed([]), /empty feed/);
});

test('rejects non-array input and releases missing required fields', () => {
  assert.throws(() => buildFeed({ message: 'API rate limit exceeded' }), /JSON array/);
  assert.throws(() => buildFeed([release(1, 'v1.0.0', { html_url: undefined })]), /html_url/);
});

test('writes releases.json and the CORS/caching headers file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-feed-'));
  try {
    writeFeed([release(1, 'v1.0.0')], join(dir, 'out'), { now: NOW });
    const written = JSON.parse(readFileSync(join(dir, 'out', 'releases.json'), 'utf8'));
    assert.equal(written.releases[0].tag_name, 'v1.0.0');
    assert.equal(readFileSync(join(dir, 'out', '_headers'), 'utf8'), FEED_HEADERS);
    assert.match(FEED_HEADERS, /Access-Control-Allow-Origin: \*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
