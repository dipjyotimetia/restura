import { createIsolateRateLimiter } from '@shared/protocol/rate-limiter';

export const { middleware: rateLimitMiddleware, reset: resetRateLimiter } =
  createIsolateRateLimiter();
