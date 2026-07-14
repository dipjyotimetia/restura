import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonReporter } from '../json';
import type { RunResult } from '../types';

describe('JsonReporter', () => {
  it('writes the RunResult as JSON to the output path', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'restura-json-'));
    const out = join(tmp, 'r.json');
    const reporter = new JsonReporter(out);
    const result: RunResult = {
      meta: { collectionName: 'X', collectionDir: '/x', startedAt: 1 },
      durationMs: 42,
      requests: [],
      summary: { total: 0, passed: 0, failed: 0, errored: 0 },
    };
    await reporter.onEnd(result);
    const json = JSON.parse(readFileSync(out, 'utf-8'));
    expect(json.meta.collectionName).toBe('X');
    expect(json.summary.total).toBe(0);
    expect(json.durationMs).toBe(42);
  });
});
