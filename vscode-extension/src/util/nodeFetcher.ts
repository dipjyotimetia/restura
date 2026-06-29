import type { Fetcher } from '../../../shared/protocol/types';

/**
 * A `Fetcher` for the VS Code Node extension host — the "4th backend" in
 * Restura's one-renderer-N-backends model. Uses the host's global `fetch`
 * (Node ≥ 18) with `redirect: 'manual'` so the shared redirect-follower owns
 * redirect policy. Intentionally NOT a copy of electron's `fetch-fetcher.ts`,
 * which pulls in the electron security tree.
 */
export const nodeFetcher: Fetcher = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.body,
    signal: req.signal,
    redirect: 'manual',
  });
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    text: () => res.text(),
    arrayBuffer: () => res.arrayBuffer(),
    contentLengthHeader: res.headers.get('content-length'),
    body: res.body,
  };
};
