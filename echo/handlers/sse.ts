import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { Env } from '../index';

const MAX_DURATION_MS = 60_000;
const INTERVAL_MS = 2_000;

export function sseEcho(c: Context<{ Bindings: Env }>): Response {
  const url = new URL(c.req.url);
  const query = Object.fromEntries(url.searchParams);

  return streamSSE(c, async (stream) => {
    const start = Date.now();
    let seq = 0;

    await stream.writeSSE({
      event: 'connected',
      id: String(seq),
      data: JSON.stringify({
        seq,
        timestamp: new Date().toISOString(),
        message: 'connected',
        url: url.pathname,
        query,
      }),
    });
    seq++;

    while (Date.now() - start < MAX_DURATION_MS) {
      await stream.sleep(INTERVAL_MS);
      if (stream.closed) break;

      const remaining = MAX_DURATION_MS - (Date.now() - start);
      await stream.writeSSE({
        event: 'echo',
        id: String(seq),
        data: JSON.stringify({
          seq,
          timestamp: new Date().toISOString(),
          message: 'echo',
          url: url.pathname,
          query,
          remainingMs: Math.max(0, remaining),
        }),
      });
      seq++;
    }

    await stream.writeSSE({
      event: 'done',
      data: JSON.stringify({ message: 'stream closed after 60s', totalEvents: seq }),
    });
  });
}
