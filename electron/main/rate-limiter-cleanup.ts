import type { WebContents } from 'electron';
import type { KeyedRateLimiter } from './ipc-rate-limiter';

/**
 * Eagerly evicts a webContents' rate-limit buckets when the renderer is
 * destroyed. Without this hook, dead webContents ids would linger in every
 * limiter's Map until the next (impossible) check from that id — a slow
 * but real memory leak across long-lived sessions that open/close windows
 * or recreate webContents on navigation.
 */
export function bindLimiterToWebContents(
  limiters: readonly KeyedRateLimiter[],
  webContents: WebContents
): void {
  const id = webContents.id;
  webContents.once('destroyed', () => {
    for (const l of limiters) l.dispose(id);
  });
}
