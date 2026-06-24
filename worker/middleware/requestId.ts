/**
 * Request-ID middleware. Mints (or accepts) an `x-restura-request-id`
 * correlation id for every `/api/*` request and stashes it on
 * `c.var.requestId`. Echoes it back in the response so callers can trace
 * end-to-end from `wrangler tail` / DiskTab / upstream access log.
 */

import { REQUEST_ID_HEADER, ensureRequestId } from '@shared/protocol/types';
import type { Context, MiddlewareHandler, Next } from 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
  }
}

const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export const requestIdMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  const incoming = c.req.header(REQUEST_ID_HEADER);
  const id = ensureRequestId({
    requestId: incoming && VALID_ID.test(incoming) ? incoming : undefined,
  });
  c.set('requestId', id);
  await next();
  c.res.headers.set(REQUEST_ID_HEADER, id);
};
