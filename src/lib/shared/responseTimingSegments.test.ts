import { describe, expect, it } from 'vitest';
import { SEGMENT_HELP, timingSegments } from './responseTimingSegments';

const labels = (s: ReturnType<typeof timingSegments>) => s.map((x) => [x.label, x.ms]);

describe('timingSegments', () => {
  it('falls back to a single Total segment without timings', () => {
    expect(labels(timingSegments({ time: 120 }, { desktop: false, https: true }))).toEqual([
      ['Total', 120],
    ]);
  });

  it('splits desktop direct connections into DNS, Connect + TLS, Waiting, Download, App', () => {
    const s = timingSegments(
      { time: 200, timings: { dns: 10, connect: 40, ttfb: 150, download: 30 } },
      { desktop: true, https: true }
    );
    expect(labels(s)).toEqual([
      ['DNS', 10],
      ['Connect + TLS', 40],
      ['Waiting', 100],
      ['Download', 30],
      ['App', 20],
    ]);
  });

  it('on web, shows Waiting, Download and the proxy hop, skipping empty phases', () => {
    const s = timingSegments(
      { time: 300, timings: { ttfb: 180, download: 0 } },
      { desktop: false, https: false }
    );
    expect(labels(s)).toEqual([
      ['Waiting', 180],
      ['Download', 0],
      ['Proxy', 120],
    ]);
  });

  it('labels plain-HTTP connects without TLS, keeps measured 0ms phases, never goes negative', () => {
    const s = timingSegments(
      { time: 50, timings: { dns: 0, connect: 20, ttfb: 10, download: 45 } },
      { desktop: true, https: false }
    );
    expect(labels(s)).toEqual([
      ['DNS', 0],
      ['Connect', 20],
      ['Waiting', 0],
      ['Download', 45],
    ]);
  });

  it('documents every label', () => {
    for (const label of [
      'DNS',
      'Connect',
      'Connect + TLS',
      'Waiting',
      'Download',
      'Proxy',
      'App',
      'Total',
    ]) {
      expect(SEGMENT_HELP[label]).toBeTruthy();
    }
  });
});
