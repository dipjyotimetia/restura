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
