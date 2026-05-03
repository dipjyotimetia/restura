export function createRateLimiter(maxRequests: number, windowMs: number) {
  const timestamps: number[] = [];
  return function check(): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    while (timestamps.length > 0 && timestamps[0]! <= windowStart) {
      timestamps.shift();
    }
    if (timestamps.length >= maxRequests) {
      return false;
    }
    timestamps.push(now);
    return true;
  };
}
