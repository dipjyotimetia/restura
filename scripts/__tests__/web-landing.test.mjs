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
import { layoutWebSite } from '../vite-plugin-web-landing.ts';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'web-landing-'));
  const out = path.join(root, 'out');
  const site = path.join(root, 'site');
  mkdirSync(out);
  mkdirSync(site);
  writeFileSync(path.join(out, 'index.html'), '<div id="root"></div>APP');
  writeFileSync(path.join(site, 'index.html'), '<script src="./landing.js"></script>LANDING');
  writeFileSync(path.join(site, 'landing.js'), 'console.log(1);');
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
