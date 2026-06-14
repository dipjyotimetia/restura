#!/usr/bin/env node
/**
 * Inject Sentry debug IDs into the built bundles and upload their source maps.
 * Chained inside `electron:publish` — after `electron:build:all`, before
 * `electron-builder` packages — so the exact JS that ships carries the same
 * debug IDs as the uploaded maps (the only way crash stacks reliably
 * symbolicate). The release must match the SDK's `restura@<version>`
 * (electron/main/lifecycle/sentry.ts), so we derive it from package.json.
 *
 * No-ops when SENTRY_AUTH_TOKEN is unset (local builds, or before a Sentry
 * project is provisioned). Each release runs this on every desktop OS leg;
 * debug IDs are content-derived, so re-uploading the identical renderer/main
 * maps is idempotent (Sentry dedups by debug ID + release).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env['SENTRY_AUTH_TOKEN']) {
  console.log('SENTRY_AUTH_TOKEN not set — skipping Sentry source map injection/upload.');
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const release = `restura@${version}`;
const paths = ['dist/web', 'dist/electron'];

function sentryCli(...args) {
  const result = spawnSync('npx', ['@sentry/cli', ...args], {
    stdio: 'inherit',
    cwd: repoRoot,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

sentryCli('sourcemaps', 'inject', ...paths);
sentryCli('sourcemaps', 'upload', '--release', release, ...paths);
