import { describe, it, expect } from 'vitest';
import { formatLoadStatsReport } from '../stats';
import type { RunResult, RequestRunResult } from '../types';
import type { LoadedRequest } from '../../runner/collectionLoader';

const fakeReq = (): LoadedRequest => ({
  filePath: '/x/y.http.yaml',
  relativePath: 'y.http.yaml',
  folderPath: [],
  type: 'http',
  request: {
    id: '1',
    name: 'req',
    type: 'http',
    method: 'GET',
    url: '/',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  } as never,
});

function result(durations: number[], statuses: number[]): RunResult {
  return {
    meta: { collectionName: 'My', collectionDir: '/x', startedAt: 1 },
    durationMs: 1000,
    requests: durations.map(
      (d, i) =>
        ({
          request: fakeReq(),
          status: statuses[i] ?? 200,
          passed: true,
          durationMs: d,
          bodyBytes: 0,
        }) as RequestRunResult
    ),
    summary: { total: durations.length, passed: durations.length, failed: 0, errored: 0 },
  };
}

describe('formatLoadStatsReport', () => {
  it('reports percentiles and request count', () => {
    const out = formatLoadStatsReport(result([10, 20, 30, 40], [200, 200, 200, 200]));
    expect(out).toContain('Load stats — My');
    expect(out).toContain('requests 4');
    expect(out).toContain('p95');
    expect(out).toContain('rps');
  });

  it('counts 4xx/5xx and transport errors as errors', () => {
    const out = formatLoadStatsReport(result([10, 20, 30], [200, 404, 0]));
    expect(out).toContain('errors   2');
  });
});
