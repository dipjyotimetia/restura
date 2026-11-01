#!/usr/bin/env node
// Print the Playwright spec files one CI shard should run, balanced by measured
// duration.
//
// `playwright test --shard=N/M` splits by test COUNT. The two web-e2e shards had
// 104 tests each but took 5.9 min vs 1.7 min, and four count-based shards were
// still 226 s vs 40-89 s of test time (a few files such as import-collection
// dominate). This assigns whole files with the longest-processing-time-first
// greedy rule from the table below, so the shards finish together.
//
//   npx playwright test $(node scripts/e2e-shard.mjs 3/4)
//
// Whole files stay together, so tests within a file keep their order and shared
// state. A spec missing from the table gets DEFAULT_SECONDS, so a new file is
// still assigned to exactly one shard and runs; refresh the table when specs
// change a lot (the Playwright `list` reporter prints per-test times in the CI
// log; sum them per file).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Same exclusion as `testIgnore` in playwright.config.ts (own CI job). */
const IGNORED = /extension-capture\.spec\.ts$/;

/** Seconds of test time per spec, measured on CI (ubuntu-latest, 2026-11-01). */
export const SPEC_SECONDS = {
  'collection-runner.spec.ts': 22,
  'command-palette.spec.ts': 2,
  'data-management.spec.ts': 15,
  'environment-manager.spec.ts': 33,
  'headers-and-settings.spec.ts': 27,
  'http.spec.ts': 26,
  'import-collection.spec.ts': 80,
  'layout-split.spec.ts': 5,
  'load-test-runs.spec.ts': 4,
  'persistence.spec.ts': 10,
  'protocols.spec.ts': 39,
  'real-ai.spec.ts': 5,
  'real-auth-advanced.spec.ts': 6,
  'real-graphql-advanced.spec.ts': 6,
  'real-graphql-http.spec.ts': 19,
  'real-graphql.spec.ts': 10,
  'real-grpc-advanced.spec.ts': 6,
  'real-grpc.spec.ts': 12,
  'real-http-advanced.spec.ts': 3,
  'real-http.spec.ts': 24,
  'real-mcp-advanced.spec.ts': 3,
  'real-mcp.spec.ts': 4,
  'real-mqtt.spec.ts': 16,
  'real-proxy-advanced.spec.ts': 5,
  'real-proxy.spec.ts': 7,
  'real-response-viz.spec.ts': 7,
  'real-socketio.spec.ts': 8,
  'real-sse-advanced.spec.ts': 3,
  'real-sse.spec.ts': 4,
  'real-websocket-advanced.spec.ts': 5,
  'real-websocket-control.spec.ts': 3,
  'real-websocket-templates.spec.ts': 3,
  'real-websocket.spec.ts': 5,
  'response-preview-csp.spec.ts': 6,
  'variable-status.spec.ts': 12,
};

/** Weight for a spec not in the table: the rough median of the measured ones. */
export const DEFAULT_SECONDS = 6;

/** Repo-relative spec paths (forward slashes), sorted. */
export function listSpecs(e2eDir) {
  return fs
    .readdirSync(e2eDir)
    .filter((f) => f.endsWith('.spec.ts') && !IGNORED.test(f))
    .sort();
}

/**
 * Deterministic longest-first greedy packing. Returns `total` arrays of spec
 * file names, each sorted alphabetically.
 */
export function assignShards(specs, total, seconds = SPEC_SECONDS) {
  const weight = (f) => seconds[f] ?? DEFAULT_SECONDS;
  const bins = Array.from({ length: total }, () => ({ load: 0, files: [] }));
  const ordered = [...specs].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const file of ordered) {
    let target = bins[0];
    for (const bin of bins) if (bin.load < target.load) target = bin;
    target.files.push(file);
    target.load += weight(file);
  }
  return bins.map((b) => b.files.sort());
}

export function parseShardArg(arg) {
  const m = /^(\d+)\/(\d+)$/.exec(arg ?? '');
  if (!m) throw new Error(`expected <current>/<total> (for example 3/4), got "${arg}"`);
  const current = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || current < 1 || current > total) {
    throw new Error(`shard ${arg} is out of range`);
  }
  return { current, total };
}

function main() {
  const { current, total } = parseShardArg(process.argv[2]);
  const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e');
  const files = assignShards(listSpecs(e2eDir), total)[current - 1] ?? [];
  // An empty list would make `playwright test` run EVERY spec in this shard.
  if (files.length === 0) {
    throw new Error(`shard ${current}/${total} has no specs; refusing to run the whole suite`);
  }
  process.stdout.write(`${files.map((f) => `e2e/${f}`).join(' ')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`e2e-shard: ${err.message}`);
    process.exit(1);
  }
}
