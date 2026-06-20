import type { Context } from 'hono';
import type { WSContext, WSEvents } from 'hono/ws';
import type { EchoEnv } from '../index';

const encoder = new TextEncoder();

export const websocketEcho = (
  _c: Context<{ Bindings: EchoEnv }>
): Omit<WSEvents<WebSocket>, 'onOpen'> => ({
  onMessage(event: MessageEvent, ws: WSContext<WebSocket>) {
    const raw = event.data as unknown;

    if (raw instanceof ArrayBuffer) {
      ws.send(raw);
      return;
    }

    if (typeof Blob !== 'undefined' && raw instanceof Blob) {
      void raw.arrayBuffer().then((buf) => ws.send(buf));
      return;
    }

    const text = typeof raw === 'string' ? raw : String(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not valid JSON — omit parsed field
    }

    const reply: Record<string, unknown> = {
      echo: true,
      received: text,
      timestamp: new Date().toISOString(),
      size: encoder.encode(text).byteLength,
    };
    if (parsed !== undefined) {
      reply.parsed = parsed;
    }

    ws.send(JSON.stringify(reply));
  },
  onClose() {},
  onError(error: Event) {
    console.error('WebSocket error', error);
  },
});
