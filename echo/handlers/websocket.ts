import type { Context } from 'hono';
import type { WSEvents } from 'hono/ws';
import type { Env } from '../index';

export const websocketEcho = (_c: Context<{ Bindings: Env }>): Omit<WSEvents<WebSocket>, 'onOpen'> => ({
  onMessage() {},
  onClose() {},
  onError() {},
});
