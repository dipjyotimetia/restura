import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { layoutWebSite, retargetAppHead } from '../vite-plugin-web-landing.ts';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'web-landing-'));
  const out = path.join(root, 'out');
  const site = path.join(root, 'site');
  mkdirSync(out);
  mkdirSync(site);
  writeFileSync(
    path.join(out, 'index.html'),
    [
      '<link rel="canonical" href="https://restura.dev/" />',
      '<meta name="robots" content="index, follow" />',
      '<meta property="og:url" content="https://restura.dev/" />',
      '<div id="root"></div>APP',
    ].join('\n')
  );
  writeFileSync(path.join(site, 'index.html'), '<script src="./landing.js"></script>LANDING');
  writeFileSync(path.join(site, 'landing.js'), 'console.log(1);');
  writeFileSync(path.join(site, '404.html'), 'NOT FOUND');
  writeFileSync(path.join(site, 'llms.txt'), '# Restura');
  return { out, site };
}

test('moves the app to /app/ and puts the landing page at /', () => {
  const { out, site } = fixture();
  layoutWebSite(out, site);

  assert.match(readFileSync(path.join(out, 'app', 'index.html'), 'utf8'), /APP/);
  const landing = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(landing, /LANDING/);

  const script = readdirSync(out).find((f) => /^landing-[0-9a-f]{10}\.js$/.test(f));
  assert.ok(script, 'content-hashed landing script is emitted');
  assert.ok(landing.includes(`src="/${script}"`), 'landing references the hashed script');
  assert.equal(existsSync(path.join(out, 'landing.js')), false);
  assert.equal(readFileSync(path.join(out, '404.html'), 'utf8'), 'NOT FOUND');
  assert.equal(readFileSync(path.join(out, 'llms.txt'), 'utf8'), '# Restura');
});

test('keeps the app shell out of the search index', () => {
  const { out, site } = fixture();
  layoutWebSite(out, site);
  const app = readFileSync(path.join(out, 'app', 'index.html'), 'utf8');
  assert.match(app, /<link rel="canonical" href="https:\/\/restura\.dev\/app\/" \/>/);
  assert.match(app, /<meta name="robots" content="noindex, follow" \/>/);
  assert.match(app, /<meta property="og:url" content="https:\/\/restura\.dev\/app\/" \/>/);
});

test('fails loudly if the app head tags it rewrites have moved', () => {
  assert.throws(() => retargetAppHead('<html></html>'), /missing/);
});

test('fails loudly when the built app is missing', () => {
  const { out, site } = fixture();
  layoutWebSite(out, site);
  // A second run finds the landing at index.html but no fresh app build to move;
  // simulate a missing build instead.
  const empty = mkdtempSync(path.join(tmpdir(), 'web-landing-empty-'));
  assert.throws(() => layoutWebSite(empty, site), /expected the built app/);
});

test('fails when the landing page stops loading its script the expected way', () => {
  const { out, site } = fixture();
  writeFileSync(path.join(site, 'index.html'), '<script src="/landing.js"></script>');
  assert.throws(() => layoutWebSite(out, site), /must load the script/);
});

test('the shipped landing FAQ structured data matches the visible FAQ', () => {
  // Google requires FAQPage answers to match the on-page text exactly.
  const html = readFileSync(new URL('../../site/index.html', import.meta.url), 'utf8');
  const text = (t) =>
    t
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  const faq = html.slice(html.indexOf('id="faq"'));
  const visible = [...faq.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => [
    text(m[1]),
    text(m[2]),
  ]);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const graph = blocks.flatMap((b) => JSON.parse(b[1])['@graph']);
  const ld = graph.find((n) => n['@type'] === 'FAQPage').mainEntity;
  assert.ok(visible.length >= 5, 'landing has a visible FAQ');
  assert.deepEqual(
    ld.map((q) => [q.name, q.acceptedAnswer.text]),
    visible
  );
});
