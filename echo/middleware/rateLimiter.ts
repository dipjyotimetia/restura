import { createRateLimiter } from '@shared/protocol/rate-limiter';

export const { middleware: rateLimitMiddleware, reset: resetRateLimiter } = createRateLimiter();
