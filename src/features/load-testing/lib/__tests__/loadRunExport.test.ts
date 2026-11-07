import { describe, expect, it } from 'vitest';
import type { LoadTestRun } from '@/store/useLoadTestStore';
import { renderLoadRunsCsv, renderLoadRunsJson } from '../loadRunExport';

const run: LoadTestRun = {
  id: 'run-1',
  method: 'GET',
  url: 'https://api.test/a,b',
  requestName: 'Say "hi"',
  request: {
    id: 'r',
    name: 'Say "hi"',
    type: 'http',
    method: 'GET',
    url: 'https://api.test/a,b',
    headers: [{ id: 'h', key: 'Authorization', value: 'Bearer secret', enabled: true }],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  },
  stats: {
    count: 10,
    errors: 1,
    min: 1,
    max: 9,
    mean: 5,
    p50: 4,
    p90: 8,
    p95: 8.5,
    p99: 9,
    rps: 20,
  },
  rps: 20,
  completedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
};

describe('load run export', () => {
  it('renders JSON without the request (it can carry credentials)', () => {
    const json = renderLoadRunsJson([run]);
    expect(json).not.toContain('Bearer secret');
    expect(JSON.parse(json)).toEqual([
      {
        id: 'run-1',
        requestName: 'Say "hi"',
        method: 'GET',
        url: 'https://api.test/a,b',
        completedAt: '2026-01-02T03:04:05.000Z',
        rps: 20,
        stats: run.stats,
      },
    ]);
  });

  it('renders CSV with escaped fields', () => {
    expect(renderLoadRunsCsv([run]).split('\n')).toEqual([
      'id,requestName,method,url,completedAt,count,errors,rps,min,mean,p50,p90,p95,p99,max',
      'run-1,"Say ""hi""",GET,"https://api.test/a,b",2026-01-02T03:04:05.000Z,10,1,20,1,5,4,8,8.5,9,9',
    ]);
  });

  it('strips credentials from the exported URL', () => {
    const leaky = { ...run, url: 'https://user:pw@api.test/x?api_key=sk_live_1&page=2' };
    for (const out of [renderLoadRunsJson([leaky]), renderLoadRunsCsv([leaky])]) {
      expect(out).not.toContain('pw@');
      expect(out).not.toContain('sk_live_1');
      expect(out).toContain('page=2');
    }
  });

  it('neutralises spreadsheet formulas in CSV text fields', () => {
    const csv = renderLoadRunsCsv([{ ...run, requestName: '=HYPERLINK("http://x")' }]);
    expect(csv.split('\n')[1]).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});
