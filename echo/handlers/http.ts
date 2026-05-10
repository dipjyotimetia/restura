import type { Context } from 'hono';
import type { Env } from '../index';

export async function httpEcho(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json({ echo: true, status: 'not implemented' });
}
