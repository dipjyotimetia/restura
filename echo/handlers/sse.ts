import type { Context } from 'hono';
import type { Env } from '../index';

export function sseEcho(c: Context<{ Bindings: Env }>): Response {
  return c.text('not implemented');
}
