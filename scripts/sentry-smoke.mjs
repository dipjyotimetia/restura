#!/usr/bin/env node
/**
 * Release-time Sentry ingest smoke test for the Electron desktop project.
 *
 * The desktop app reads the same DSN from packaged package.json at runtime.
 * This script sends one lightweight envelope during release builds so a missing
 * or wrong DSN/project fails before installers are published.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dsn = process.env['SENTRY_DSN'];

if (!dsn) {
  console.error('SENTRY_DSN is required for release Sentry smoke test.');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const release = `restura@${version}`;

function parseDsn(raw) {
  const url = new URL(raw);
  const projectId = url.pathname.split('/').filter(Boolean).at(-1);
  if (!projectId || !url.username) {
    throw new Error('SENTRY_DSN must include a public key and project id.');
  }
  return {
    publicKey: url.username,
    endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
  };
}

const { publicKey, endpoint } = parseDsn(dsn);
const now = new Date().toISOString();
const eventId = randomUUID().replaceAll('-', '');
const envelope = [
  JSON.stringify({
    event_id: eventId,
    dsn,
    sent_at: now,
    sdk: { name: 'restura.release-smoke', version: '1.0.0' },
  }),
  JSON.stringify({ type: 'event' }),
  JSON.stringify({
    event_id: eventId,
    timestamp: now,
    platform: 'javascript',
    level: 'info',
    logger: 'release-smoke',
    message: 'Restura desktop Sentry release smoke test',
    release,
    environment: 'production',
    tags: {
      app: 'restura',
      target: 'desktop',
      ci_smoke_test: 'true',
    },
  }),
  '',
].join('\n');

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-sentry-envelope',
    'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=restura.release-smoke/1.0.0`,
  },
  body: envelope,
});

if (!response.ok) {
  const body = await response.text().catch(() => '');
  console.error(`Sentry smoke test failed: ${response.status} ${response.statusText}`);
  if (body) console.error(body);
  process.exit(1);
}

console.log(`Sentry smoke event accepted for ${release}.`);
