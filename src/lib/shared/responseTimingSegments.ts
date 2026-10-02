import type { Response } from '@/types';

export interface TimingSegment {
  label: string;
  ms: number;
  color: string;
  emphasised?: boolean;
}

/**
 * Waterfall segments for a response. Uses the proxy core's measured
 * breakdown when present: DNS and connect (desktop direct connections),
 * waiting for the server, and download. Whatever's left of the end-to-end
 * `time` is the hop to the proxy (web) or the app's own work (desktop). Old
 * responses without timings keep a single honest "Total" segment.
 */
export function timingSegments(
  response: Pick<Response, 'time' | 'timings'>,
  options: { desktop: boolean; https: boolean }
): TimingSegment[] {
  const t = response.timings;
  if (!t) {
    return [
      { label: 'Total', ms: response.time, color: 'var(--color-proto-http)', emphasised: true },
    ];
  }
  const dns = t.dns ?? 0;
  const connect = t.connect ?? 0;
  const waiting = Math.max(0, t.ttfb - dns - connect);
  const overhead = Math.max(0, response.time - t.ttfb - t.download);
  // Measured phases are shown even when they round to 0 ms (e.g. a localhost
  // connect) — that's information, not noise. Only an empty overhead is dropped.
  return [
    ...(t.dns !== undefined ? [{ label: 'DNS', ms: dns, color: 'var(--color-info)' }] : []),
    ...(t.connect !== undefined
      ? [
          {
            label: options.https ? 'Connect + TLS' : 'Connect',
            ms: connect,
            color: 'var(--color-method-put)',
          },
        ]
      : []),
    { label: 'Waiting', ms: waiting, color: 'var(--color-proto-http)', emphasised: true },
    { label: 'Download', ms: t.download, color: 'var(--color-warning)' },
    ...(overhead > 0
      ? [{ label: options.desktop ? 'App' : 'Proxy', ms: overhead, color: 'var(--color-neutral)' }]
      : []),
  ];
}

/** One-line explanation of a segment, for the Timeline breakdown. */
export const SEGMENT_HELP: Record<string, string> = {
  DNS: 'Resolving the host name.',
  Connect: 'Opening the TCP connection.',
  'Connect + TLS': 'Opening the TCP connection and the TLS handshake.',
  Waiting: 'Request sent until the response headers arrived (includes any redirects).',
  Download: 'Receiving the response body.',
  Proxy: 'Round trip between the app and the Restura proxy.',
  App: 'Time in the app itself (scripts, IPC, processing).',
  Total: 'End-to-end time. A breakdown isn’t available for this response.',
};
