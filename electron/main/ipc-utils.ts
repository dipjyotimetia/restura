import { webContents } from 'electron';

/**
 * Send an IPC event to the renderer that owns `webContentsId`, skipping
 * destroyed or missing webContents. Extracted because every protocol
 * handler (http, ws, sse, mcp, kafka) needs the same guarded `wc.send()`
 * pattern.
 */
export function emitTo(webContentsId: number, channel: string, ...args: unknown[]): void {
  const wc = webContents.fromId(webContentsId);
  if (wc && !wc.isDestroyed()) {
    wc.send(channel, ...args);
  }
}

/**
 * Normalize an unknown thrown value to a string message. The same
 * `err instanceof Error ? err.message : String(err)` idiom was duplicated
 * across the protocol handlers; share it so error surfacing is consistent.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
